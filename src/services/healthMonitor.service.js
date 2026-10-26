const crypto = require('crypto');
const { Op } = require('sequelize');
const { Camera, College, Device, CameraHealth, CameraStatusHistory } = require('../models');
const { decrypt } = require('../utils/crypto');
const { probeMany } = require('./connectivity.service');

const config = {
    enabled: process.env.HEALTH_CHECK_ENABLED !== 'false',
    // How often each healthy camera is checked
    intervalMin: parseInt(process.env.HEALTH_CHECK_INTERVAL_MIN) || 15,
    // How often a failing camera is re-checked
    failingIntervalMin: parseInt(process.env.HEALTH_CHECK_FAILING_INTERVAL_MIN) || 3,
    // Consecutive failed checks before an online camera is marked as not working
    failThreshold: parseInt(process.env.HEALTH_CHECK_FAIL_THRESHOLD) || 2,
    retentionDays: parseInt(process.env.HEALTH_HISTORY_RETENTION_DAYS) || 90,
    tickSeconds: 60
};

const FAILURE_STATUSES = ['stream_error', 'no_response', 'offline'];
const UPSERT_FIELDS = ['collegeId', 'status', 'lastResult', 'rtspCode', 'latencyMs', 'error', 'consecutiveFailures', 'lastCheckedAt', 'lastOnlineAt', 'statusSince'];

let currentJob = null;
let queuedJob = null;
let lastManualJob = null;
let dataVersion = 0;

// Saved credentials exactly as stored, except URL-encoded '@' (%40) is turned back into '@'
const decodeCredential = (value) => (decrypt(value) || '').replace(/%40/gi, '@');

// Full RTSP link from the device template with the camera's saved credentials
const buildRtspLink = (camera) => {
    const fallback = `rtsp://${camera.ipAddress}:${camera.rtspPort}/`;
    const template = camera.Device && camera.Device.rtspLink;
    if (!template) return fallback;
    const link = template
        .replace(/\$userTemplate/g, () => decodeCredential(camera.username))
        .replace(/\$passwordTemplate/g, () => decodeCredential(camera.password))
        .replace(/\$ipTemplate/g, camera.ipAddress)
        .replace(/\$portTemplate/g, camera.rtspPort.toString())
        .replace(/\$channelTemplate/g, camera.channel);
    return /^rtsps?:\/\//i.test(link) ? link : fallback;
};

// Active cameras of active colleges, with what's needed to probe and persist them
const loadCameras = (where = {}) => Camera.findAll({
    where: { isActive: true, ...where },
    include: [
        { model: College, where: { isActive: true }, attributes: ['id', 'name'] },
        { model: Device, attributes: ['rtspLink'], required: false },
        { model: CameraHealth, required: false }
    ]
});

const nextState = (prev, result, now) => {
    const raw = result.status;
    const failures = raw === 'online' ? 0 : (prev ? prev.consecutiveFailures : 0) + 1;

    let status;
    if (!prev || raw === 'online') status = raw;
    // A single failed check of a working camera isn't confirmed yet (avoids flapping on network blips)
    else if (prev.status === 'online' && failures < config.failThreshold) status = 'online';
    else status = raw;

    const changed = !prev || prev.status !== status;
    return {
        changed,
        state: {
            status,
            lastResult: raw,
            rtspCode: result.rtspCode,
            latencyMs: result.latencyMs,
            error: result.error ? String(result.error).slice(0, 255) : null,
            consecutiveFailures: failures,
            lastCheckedAt: now,
            lastOnlineAt: raw === 'online' ? now : (prev ? prev.lastOnlineAt : null),
            statusSince: changed ? now : prev.statusSince
        }
    };
};

const persistResults = async (cameras, results) => {
    const now = new Date();
    const healthRows = [];
    const historyRows = [];

    for (const camera of cameras) {
        const result = results.get(camera.id);
        if (!result) continue;
        const prev = camera.CameraHealth;
        const { changed, state } = nextState(prev, result, now);
        healthRows.push({ cameraId: camera.id, collegeId: camera.collegeId, ...state });
        if (changed) {
            historyRows.push({
                cameraId: camera.id,
                collegeId: camera.collegeId,
                fromStatus: prev ? prev.status : null,
                toStatus: state.status,
                rtspCode: state.rtspCode,
                error: state.error,
                changedAt: now
            });
        }
    }

    for (let i = 0; i < healthRows.length; i += 500) {
        await CameraHealth.bulkCreate(healthRows.slice(i, i + 500), { updateOnDuplicate: UPSERT_FIELDS });
    }
    for (let i = 0; i < historyRows.length; i += 500) {
        await CameraStatusHistory.bulkCreate(historyRows.slice(i, i + 500));
    }
    dataVersion++;
};

const publicJob = (job) => job && {
    id: job.id,
    type: job.type,
    collegeId: job.collegeId,
    collegeName: job.collegeName,
    state: job.state,
    total: job.total,
    done: job.done,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error
};

const runJob = async (job) => {
    currentJob = job;
    job.state = 'running';
    job.startedAt = new Date();
    try {
        const cameras = job.cameras || await loadCameras(job.where);
        job.total = cameras.length;
        const targets = cameras.map(camera => ({
            key: camera.id,
            host: camera.ipAddress,
            port: camera.rtspPort,
            uri: buildRtspLink(camera)
        }));
        const results = await probeMany(targets, () => { job.done++; });
        await persistResults(cameras, results);
        job.state = 'finished';
    } catch (err) {
        console.error(`[HealthMonitor] ${job.type} check failed:`, err);
        job.state = 'failed';
        job.error = err.message;
    } finally {
        job.finishedAt = new Date();
        delete job.cameras;
        if (job.type !== 'scheduled') lastManualJob = job;
        currentJob = null;
        if (queuedJob) {
            const next = queuedJob;
            queuedJob = null;
            runJob(next);
        }
    }
};

/**
 * Start a manual check. Only one check runs at a time: if a manual check is already
 * running or queued, that one is returned instead of starting another. A manual check
 * requested during a scheduled batch is queued and starts as soon as the batch ends.
 */
const requestCheck = ({ where = {}, type, collegeId = null, collegeName = null, requestedBy = null }) => {
    const active = [currentJob, queuedJob].find(j => j && j.type !== 'scheduled');
    if (active) return { started: false, job: publicJob(active) };

    const job = {
        id: crypto.randomUUID(), type, collegeId, collegeName, requestedBy, where,
        state: 'queued', total: 0, done: 0, startedAt: null, finishedAt: null, error: null
    };
    if (currentJob) queuedJob = job;
    else runJob(job);
    return { started: true, job: publicJob(job) };
};

/**
 * Every minute, check the cameras that are due: never checked, failing and older than
 * failingIntervalMin, or healthy and older than intervalMin. The batch size is capped so
 * the full set is spread across the interval instead of being checked all at once.
 */
let tickInProgress = false;
const scheduledTick = async () => {
    if (currentJob || queuedJob || tickInProgress) return;
    tickInProgress = true;
    try {
        const now = Date.now();
        const cameras = await loadCameras();
        const due = cameras.filter(camera => {
            const h = camera.CameraHealth;
            if (!h) return true;
            const age = now - new Date(h.lastCheckedAt).getTime();
            const failing = h.status !== 'online' || h.consecutiveFailures > 0;
            return age >= (failing ? config.failingIntervalMin : config.intervalMin) * 60000;
        });
        if (due.length === 0) return;

        const rank = (c) => !c.CameraHealth ? 0 : new Date(c.CameraHealth.lastCheckedAt).getTime();
        due.sort((a, b) => rank(a) - rank(b));
        const cap = Math.max(50, Math.ceil(cameras.length / config.intervalMin) * 2);

        // A manual check may have started while cameras were loading
        if (currentJob || queuedJob) return;
        await runJob({
            id: crypto.randomUUID(), type: 'scheduled', cameras: due.slice(0, cap),
            state: 'queued', total: 0, done: 0, startedAt: null, finishedAt: null, error: null
        });
    } catch (err) {
        console.error('[HealthMonitor] Scheduled tick failed:', err);
    } finally {
        tickInProgress = false;
    }
};

const pruneHistory = async () => {
    try {
        const cutoff = new Date(Date.now() - config.retentionDays * 86400000);
        const removed = await CameraStatusHistory.destroy({ where: { changedAt: { [Op.lt]: cutoff } } });
        if (removed) console.log(`[HealthMonitor] Pruned ${removed} history rows older than ${config.retentionDays} days`);
    } catch (err) {
        console.error('[HealthMonitor] History prune failed:', err);
    }
};

const start = async () => {
    if (!config.enabled) {
        console.log('[HealthMonitor] Disabled (HEALTH_CHECK_ENABLED=false)');
        return;
    }
    try {
        // Created here directly so the monitor doesn't depend on the global sequelize.sync succeeding
        await CameraHealth.sync();
        await CameraStatusHistory.sync();
    } catch (err) {
        console.error('[HealthMonitor] Could not create health tables, monitor not started:', err);
        return;
    }
    console.log(`[HealthMonitor] Started: healthy every ${config.intervalMin} min, failing every ${config.failingIntervalMin} min`);
    setTimeout(scheduledTick, 10000);
    setInterval(scheduledTick, config.tickSeconds * 1000);
    pruneHistory();
    setInterval(pruneHistory, 6 * 3600000);
};

const getJobs = () => ({
    current: publicJob(currentJob),
    queued: publicJob(queuedJob),
    lastManual: publicJob(lastManualJob)
});

module.exports = {
    config,
    FAILURE_STATUSES,
    start,
    requestCheck,
    getJobs,
    getDataVersion: () => dataVersion
};
