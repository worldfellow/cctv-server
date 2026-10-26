const { Op } = require('sequelize');
const { College, Camera, Device, CameraHealth, CameraStatusHistory } = require('../models');
const healthMonitor = require('./healthMonitor.service');

const CACHE_TTL_MS = 15000;
const cache = new Map();

const STATUS_SEVERITY = { down: 0, partial: 1, pending: 2, working: 3, no_cameras: 4, inactive: 5 };

const accessError = (message) => Object.assign(new Error(message), { status: 403 });

const hasAllColleges = (user) => user.role === 'SUPER_ADMIN' || (user.allowedColleges || []).includes('ALL');

// Sequelize where clause on College.id limiting results to what the user may see
const collegeScope = (user, collegeId = null) => {
    if (hasAllColleges(user)) return collegeId ? { id: collegeId } : {};
    const allowed = user.allowedColleges || [];
    if (collegeId) {
        if (!allowed.includes(collegeId)) throw accessError('Access denied to this college');
        return { id: collegeId };
    }
    return { id: { [Op.in]: allowed } };
};

const scopeKey = (user) => hasAllColleges(user) ? 'ALL' : [...(user.allowedColleges || [])].sort().join(',');

/**
 * Time-weighted uptime from confirmed status changes inside the window.
 * changes: this camera's history rows with changedAt >= windowStart, oldest first.
 */
const computeUptime = (currentStatus, changes, windowStart, now) => {
    if (!currentStatus) return { uptime: null, outages: 0 };
    let segStart = windowStart;
    let status;
    let rest = changes;

    if (changes.length === 0) {
        status = currentStatus;
    } else if (changes[0].fromStatus === null) {
        // Camera started being tracked inside the window
        segStart = changes[0].changedAt.getTime();
        status = changes[0].toStatus;
        rest = changes.slice(1);
    } else {
        status = changes[0].fromStatus;
    }

    let online = 0;
    let total = 0;
    let outages = 0;
    for (const change of rest) {
        const at = change.changedAt.getTime();
        total += at - segStart;
        if (status === 'online') online += at - segStart;
        if (status === 'online' && change.toStatus !== 'online') outages++;
        status = change.toStatus;
        segStart = at;
    }
    total += now - segStart;
    if (status === 'online') online += now - segStart;

    return { uptime: total > 0 ? online / total * 100 : (status === 'online' ? 100 : 0), outages };
};

const round1 = (n) => n === null ? null : Math.round(n * 10) / 10;

const maxDate = (dates) => dates.length ? new Date(Math.max(...dates.map(d => new Date(d).getTime()))) : null;
const minDate = (dates) => dates.length ? new Date(Math.min(...dates.map(d => new Date(d).getTime()))) : null;

/**
 * Build per-college rows (and per-camera health) for everything in the user's scope,
 * purely from stored health data. No cameras are contacted here.
 */
const buildRows = async (user, days) => {
    const key = `${scopeKey(user)}|${days}`;
    const cached = cache.get(key);
    if (cached && cached.version === healthMonitor.getDataVersion() && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.data;
    }

    const now = Date.now();
    const windowStart = now - days * 86400000;

    const colleges = await College.findAll({
        where: collegeScope(user),
        attributes: ['id', 'name', 'address', 'contactEmail', 'isActive'],
        order: [['name', 'ASC']],
        include: [{
            model: Camera,
            required: false,
            attributes: ['id', 'collegeId', 'isActive'],
            include: [{ model: CameraHealth, required: false }]
        }]
    });

    const cameraIds = colleges.flatMap(c => c.Cameras.map(cam => cam.id));
    const historyByCamera = new Map();
    if (cameraIds.length) {
        const history = await CameraStatusHistory.findAll({
            where: { changedAt: { [Op.gte]: new Date(windowStart) }, cameraId: { [Op.in]: cameraIds } },
            attributes: ['cameraId', 'fromStatus', 'toStatus', 'changedAt'],
            order: [['changedAt', 'ASC'], ['id', 'ASC']],
            raw: true
        });
        history.forEach(row => {
            row.changedAt = new Date(row.changedAt);
            if (!historyByCamera.has(row.cameraId)) historyByCamera.set(row.cameraId, []);
            historyByCamera.get(row.cameraId).push(row);
        });
    }

    const cameraHealth = new Map();
    const rows = colleges.map(college => {
        const counts = { online: 0, stream_error: 0, no_response: 0, offline: 0, pending: 0, disabled: 0 };
        const uptimes = [];
        let outages = 0;
        const failingSince = [];
        const checkedAt = [];

        college.Cameras.forEach(camera => {
            const h = camera.CameraHealth;
            const enabled = college.isActive && camera.isActive;
            const { uptime, outages: camOutages } = computeUptime(h && h.status, historyByCamera.get(camera.id) || [], windowStart, now);
            cameraHealth.set(camera.id, { uptime: round1(uptime), outages: camOutages });

            if (!enabled) { counts.disabled++; return; }
            if (!h) { counts.pending++; return; }
            counts[h.status]++;
            checkedAt.push(h.lastCheckedAt);
            if (h.status !== 'online') failingSince.push(h.statusSince);
            if (uptime !== null) uptimes.push(uptime);
            outages += camOutages;
        });

        const activeCameras = college.Cameras.length - counts.disabled;
        const checked = activeCameras - counts.pending;
        const notWorking = counts.stream_error + counts.no_response + counts.offline;

        let status;
        if (!college.isActive) status = 'inactive';
        else if (activeCameras === 0) status = 'no_cameras';
        else if (checked === 0) status = 'pending';
        else if (counts.online === checked) status = 'working';
        else if (counts.online === 0) status = 'down';
        else status = 'partial';

        return {
            id: college.id,
            name: college.name,
            address: college.address,
            contactEmail: college.contactEmail,
            isActive: college.isActive,
            status,
            totalCameras: college.Cameras.length,
            activeCameras,
            online: counts.online,
            streamError: counts.stream_error,
            noResponse: counts.no_response,
            offline: counts.offline,
            notWorking,
            pending: counts.pending,
            disabled: counts.disabled,
            health: checked ? Math.round(counts.online / checked * 100) : null,
            uptime: uptimes.length ? round1(uptimes.reduce((a, b) => a + b, 0) / uptimes.length) : null,
            outages,
            // When the college last had a working camera (only meaningful when status is down)
            downSince: status === 'down' ? maxDate(failingSince) : null,
            oldestCheckAt: minDate(checkedAt),
            latestCheckAt: maxDate(checkedAt)
        };
    });

    const summary = {
        colleges: rows.length,
        working: 0, partial: 0, down: 0, pending: 0, noCameras: 0, inactive: 0,
        cameras: 0, online: 0, streamError: 0, noResponse: 0, offline: 0, notWorking: 0, pendingCameras: 0, disabled: 0,
        uptime: null,
        oldestCheckAt: minDate(rows.map(r => r.oldestCheckAt).filter(Boolean)),
        latestCheckAt: maxDate(rows.map(r => r.latestCheckAt).filter(Boolean))
    };
    const statusKey = { working: 'working', partial: 'partial', down: 'down', pending: 'pending', no_cameras: 'noCameras', inactive: 'inactive' };
    const collegeUptimes = [];
    rows.forEach(r => {
        summary[statusKey[r.status]]++;
        summary.cameras += r.totalCameras;
        summary.online += r.online;
        summary.streamError += r.streamError;
        summary.noResponse += r.noResponse;
        summary.offline += r.offline;
        summary.notWorking += r.notWorking;
        summary.pendingCameras += r.pending;
        summary.disabled += r.disabled;
        if (r.uptime !== null) collegeUptimes.push(r.uptime);
    });
    summary.uptime = collegeUptimes.length ? round1(collegeUptimes.reduce((a, b) => a + b, 0) / collegeUptimes.length) : null;

    const data = { rows, summary, cameraHealth, days };
    cache.set(key, { at: Date.now(), version: healthMonitor.getDataVersion(), data });
    return data;
};

const matchesFilter = (row, status) => {
    if (!status || status === 'all') return true;
    if (status === 'other') return ['no_cameras', 'inactive', 'pending'].includes(row.status);
    return row.status === status;
};

const SORTERS = {
    name: (a, b) => a.name.localeCompare(b.name),
    status: (a, b) => STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status] || (a.health ?? 101) - (b.health ?? 101) || a.name.localeCompare(b.name),
    uptime: (a, b) => (a.uptime ?? 101) - (b.uptime ?? 101) || a.name.localeCompare(b.name),
    outages: (a, b) => b.outages - a.outages || a.name.localeCompare(b.name)
};

const filterRows = (rows, { search, status, sort }) => {
    const query = (search || '').trim().toLowerCase();
    return rows
        .filter(r => (!query || r.name.toLowerCase().includes(query)) && matchesFilter(r, status))
        .sort(SORTERS[sort] || SORTERS.status);
};

// Detailed camera list (with health) for the given colleges
const getCameraDetails = async (user, collegeIds, days) => {
    const { cameraHealth } = await buildRows(user, days);
    const cameras = await Camera.findAll({
        where: { collegeId: { [Op.in]: collegeIds } },
        attributes: ['id', 'collegeId', 'name', 'location', 'ipAddress', 'rtspPort', 'channel', 'isActive'],
        include: [
            { model: College, attributes: ['name', 'isActive'] },
            { model: Device, attributes: ['deviceName'], required: false },
            { model: CameraHealth, required: false }
        ],
        order: [['name', 'ASC']]
    });

    return cameras.map(camera => {
        const h = camera.CameraHealth;
        const enabled = camera.isActive && camera.College && camera.College.isActive;
        const extra = cameraHealth.get(camera.id) || { uptime: null, outages: 0 };
        let status = 'pending';
        if (!enabled) status = 'disabled';
        else if (h) status = h.status;

        return {
            id: camera.id,
            collegeId: camera.collegeId,
            collegeName: camera.College ? camera.College.name : null,
            name: camera.name,
            location: camera.location,
            ipAddress: camera.ipAddress,
            rtspPort: camera.rtspPort,
            channel: camera.channel,
            deviceName: camera.Device ? camera.Device.deviceName : null,
            isActive: camera.isActive,
            status,
            lastResult: h ? h.lastResult : null,
            unconfirmedFailure: !!(h && h.status === 'online' && h.lastResult !== 'online'),
            rtspCode: h ? h.rtspCode : null,
            latencyMs: h ? h.latencyMs : null,
            error: h ? h.error : (enabled ? 'Not checked yet' : (camera.isActive ? 'College is inactive' : 'Camera is disabled')),
            lastCheckedAt: h ? h.lastCheckedAt : null,
            lastOnlineAt: h ? h.lastOnlineAt : null,
            statusSince: h ? h.statusSince : null,
            uptime: extra.uptime,
            outages: extra.outages
        };
    });
};

module.exports = { collegeScope, buildRows, filterRows, getCameraDetails };
