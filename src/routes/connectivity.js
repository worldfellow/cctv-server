const express = require('express');
const router = express.Router();
const exceljs = require('exceljs');
const PDFDocument = require('pdfkit');
const { College } = require('../models');
const authMiddleware = require('../middleware/auth');
const healthMonitor = require('../services/healthMonitor.service');
const { collegeScope, buildRows, filterRows, getCameraDetails } = require('../services/healthReport.service');

const COLLEGE_STATUS_LABELS = {
    working: 'Working',
    partial: 'Partially Working',
    down: 'Not Working',
    pending: 'Not Checked Yet',
    no_cameras: 'No Cameras',
    inactive: 'College Inactive'
};

const CAMERA_STATUS_LABELS = {
    online: 'Online',
    stream_error: 'Stream Error',
    no_response: 'No RTSP Response',
    offline: 'Offline',
    pending: 'Not Checked Yet',
    disabled: 'Disabled'
};

const STATUS_COLORS = {
    working: '16A34A', online: '16A34A',
    partial: 'D97706', no_response: 'D97706', stream_error: 'D97706',
    down: 'DC2626', offline: 'DC2626',
    no_cameras: '64748B', inactive: '64748B', disabled: '64748B', pending: '64748B'
};

const ALLOWED_DAYS = [1, 7, 30, 90];
const parseDays = (value) => ALLOWED_DAYS.includes(parseInt(value)) ? parseInt(value) : 7;

const formatDateTime = (value) => value ? new Date(value).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
}) : '-';

const formatDuration = (since) => {
    if (!since) return '-';
    const minutes = Math.floor((Date.now() - new Date(since).getTime()) / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

const fileStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

// Colleges to export: one college when ?collegeId= is given, otherwise the current list filters
const selectForExport = (req, rows) => {
    if (!req.query.collegeId) return { colleges: filterRows(rows, req.query), college: null };
    collegeScope(req.user, req.query.collegeId);
    const college = rows.find(r => r.id === req.query.collegeId);
    if (!college) throw Object.assign(new Error('College not found'), { status: 404 });
    return { colleges: [college], college };
};

// Totals for exactly the exported colleges
const summarize = (colleges) => {
    const sum = (key) => colleges.reduce((total, c) => total + c[key], 0);
    const count = (status) => colleges.filter(c => c.status === status).length;
    const uptimes = colleges.map(c => c.uptime).filter(u => u !== null);
    const checks = colleges.map(c => c.oldestCheckAt).filter(Boolean).map(d => new Date(d).getTime());
    return {
        colleges: colleges.length,
        working: count('working'), partial: count('partial'), down: count('down'),
        pending: count('pending'), noCameras: count('no_cameras'), inactive: count('inactive'),
        cameras: sum('totalCameras'), online: sum('online'), notWorking: sum('notWorking'),
        pendingCameras: sum('pending'), disabled: sum('disabled'),
        uptime: uptimes.length ? Math.round(uptimes.reduce((a, b) => a + b, 0) / uptimes.length * 10) / 10 : null,
        oldestCheckAt: checks.length ? new Date(Math.min(...checks)) : null
    };
};

const exportFileName = (college, ext) => {
    const label = college ? `${college.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}_` : '';
    return `College_Connection_Status_${label}${fileStamp()}.${ext}`;
};

const handleError = (res, error, message) => {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error(`${message}:`, error);
    res.status(500).json({ message });
};

// Overall counts for the user's colleges plus monitor/job state
router.get('/summary', authMiddleware, async (req, res) => {
    try {
        const { summary, days } = await buildRows(req.user, parseDays(req.query.days));
        res.json({
            ...summary,
            days,
            monitor: {
                enabled: healthMonitor.config.enabled,
                intervalMin: healthMonitor.config.intervalMin,
                failingIntervalMin: healthMonitor.config.failingIntervalMin,
                failThreshold: healthMonitor.config.failThreshold
            },
            jobs: healthMonitor.getJobs()
        });
    } catch (error) {
        handleError(res, error, 'Error fetching connectivity summary');
    }
});

// Paginated, filterable college list (from stored health data)
router.get('/colleges', authMiddleware, async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
        const { rows } = await buildRows(req.user, parseDays(req.query.days));
        const filtered = filterRows(rows, req.query);

        res.json({
            data: filtered.slice((page - 1) * limit, page * limit),
            total: filtered.length,
            page,
            limit,
            totalPages: Math.max(Math.ceil(filtered.length / limit), 1)
        });
    } catch (error) {
        handleError(res, error, 'Error fetching college connectivity');
    }
});

// Camera-level health for one college (loaded when a college row is expanded)
router.get('/colleges/:id/cameras', authMiddleware, async (req, res) => {
    try {
        collegeScope(req.user, req.params.id);
        res.json(await getCameraDetails(req.user, [req.params.id], parseDays(req.query.days)));
    } catch (error) {
        handleError(res, error, 'Error fetching camera connectivity');
    }
});

// Current / queued / last manual check
router.get('/job', authMiddleware, (req, res) => {
    res.json(healthMonitor.getJobs());
});

// Start a manual check of all accessible cameras, or of one college (body: { collegeId })
router.post('/recheck', authMiddleware, async (req, res) => {
    try {
        const collegeId = req.body && req.body.collegeId;
        let where = {};
        let collegeName = null;

        if (collegeId) {
            collegeScope(req.user, collegeId);
            const college = await College.findByPk(collegeId, { attributes: ['name'] });
            if (!college) return res.status(404).json({ message: 'College not found' });
            where = { collegeId };
            collegeName = college.name;
        } else {
            const scope = collegeScope(req.user);
            if (scope.id) where = { collegeId: scope.id };
        }

        const result = healthMonitor.requestCheck({
            where,
            type: collegeId ? 'college' : 'full',
            collegeId,
            collegeName,
            requestedBy: req.user.email
        });
        res.status(result.started ? 202 : 200).json(result);
    } catch (error) {
        handleError(res, error, 'Error starting connectivity check');
    }
});

// Export as Excel (streamed row by row so thousands of cameras stay cheap)
router.get('/export/excel', authMiddleware, async (req, res) => {
    try {
        const days = parseDays(req.query.days);
        const { rows } = await buildRows(req.user, days);
        const { colleges, college } = selectForExport(req, rows);
        const summary = summarize(colleges);
        const cameras = await getCameraDetails(req.user, colleges.map(c => c.id), days);
        const collegeOrder = new Map(colleges.map((c, i) => [c.id, i]));
        cameras.sort((a, b) => collegeOrder.get(a.collegeId) - collegeOrder.get(b.collegeId) || a.name.localeCompare(b.name));

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${exportFileName(college, 'xlsx')}`);

        const workbook = new exceljs.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
        const headerStyle = (sheet) => {
            const header = sheet.getRow(1);
            header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
            header.commit();
        };
        const statusFont = (key) => ({ bold: true, color: { argb: 'FF' + STATUS_COLORS[key] } });

        const collegeSheet = workbook.addWorksheet('College Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
        collegeSheet.columns = [
            { header: 'College Name', key: 'name', width: 36 },
            { header: 'Connection Status', key: 'status', width: 20 },
            { header: 'Total Cameras', key: 'totalCameras', width: 14 },
            { header: 'Online', key: 'online', width: 10 },
            { header: 'Not Working', key: 'notWorking', width: 13 },
            { header: 'Stream Error', key: 'streamError', width: 13 },
            { header: 'No RTSP Response', key: 'noResponse', width: 17 },
            { header: 'Offline', key: 'offline', width: 10 },
            { header: 'Not Checked Yet', key: 'pending', width: 16 },
            { header: 'Disabled', key: 'disabled', width: 10 },
            { header: 'Health %', key: 'health', width: 10 },
            { header: `Uptime % (${days}d)`, key: 'uptime', width: 15 },
            { header: `Outages (${days}d)`, key: 'outages', width: 14 },
            { header: 'Not Working For', key: 'downFor', width: 16 },
            { header: 'Last Checked', key: 'lastChecked', width: 20 },
            { header: 'Address', key: 'address', width: 40 },
            { header: 'Contact Email', key: 'contactEmail', width: 30 }
        ];
        headerStyle(collegeSheet);
        colleges.forEach(c => {
            const row = collegeSheet.addRow({
                ...c,
                status: COLLEGE_STATUS_LABELS[c.status],
                downFor: c.downSince ? formatDuration(c.downSince) : '',
                lastChecked: formatDateTime(c.latestCheckAt)
            });
            row.getCell('status').font = statusFont(c.status);
            row.commit();
        });
        collegeSheet.commit();

        const cameraSheet = workbook.addWorksheet('Camera Details', { views: [{ state: 'frozen', ySplit: 1 }] });
        cameraSheet.columns = [
            { header: 'College Name', key: 'collegeName', width: 32 },
            { header: 'Camera Name', key: 'name', width: 26 },
            { header: 'Location', key: 'location', width: 22 },
            { header: 'IP Address', key: 'ipAddress', width: 16 },
            { header: 'RTSP Port', key: 'rtspPort', width: 10 },
            { header: 'Channel', key: 'channel', width: 10 },
            { header: 'Device', key: 'deviceName', width: 16 },
            { header: 'Status', key: 'status', width: 18 },
            { header: 'In This Status For', key: 'statusFor', width: 18 },
            { header: `Uptime % (${days}d)`, key: 'uptime', width: 15 },
            { header: `Outages (${days}d)`, key: 'outages', width: 14 },
            { header: 'Response Time (ms)', key: 'latencyMs', width: 18 },
            { header: 'Last Checked', key: 'lastChecked', width: 20 },
            { header: 'Last Online', key: 'lastOnline', width: 20 },
            { header: 'Details', key: 'details', width: 42 }
        ];
        headerStyle(cameraSheet);
        cameras.forEach(c => {
            const row = cameraSheet.addRow({
                ...c,
                status: CAMERA_STATUS_LABELS[c.status],
                statusFor: c.statusSince && c.status !== 'disabled' ? formatDuration(c.statusSince) : '',
                lastChecked: formatDateTime(c.lastCheckedAt),
                lastOnline: formatDateTime(c.lastOnlineAt),
                details: c.unconfirmedFailure ? `Last check failed (${c.error}), awaiting confirmation` : (c.error || (c.rtspCode ? `RTSP ${c.rtspCode}` : ''))
            });
            row.getCell('status').font = statusFont(c.status);
            row.commit();
        });
        cameraSheet.commit();

        const infoSheet = workbook.addWorksheet('Report Info');
        infoSheet.columns = [{ header: 'Item', key: 'k', width: 30 }, { header: 'Value', key: 'v', width: 30 }];
        [
            ...(college ? [['College', college.name], ['College Status', COLLEGE_STATUS_LABELS[college.status]]] : []),
            ['Generated At', formatDateTime(new Date())],
            ['Oldest Camera Check', formatDateTime(summary.oldestCheckAt)],
            ['Uptime Window', `${days} day(s)`],
            ['Colleges', summary.colleges],
            ['Working', summary.working],
            ['Partially Working', summary.partial],
            ['Not Working', summary.down],
            ['Not Checked Yet', summary.pending],
            ['No Cameras', summary.noCameras],
            ['College Inactive', summary.inactive],
            ['Total Cameras', summary.cameras],
            ['Cameras Online', summary.online],
            ['Cameras Not Working', summary.notWorking],
            ['Cameras Not Checked Yet', summary.pendingCameras],
            ['Cameras Disabled', summary.disabled],
            [`Average Uptime % (${days}d)`, summary.uptime ?? '-']
        ].forEach(([k, v]) => infoSheet.addRow({ k, v }).commit());
        infoSheet.commit();

        await workbook.commit();
    } catch (error) {
        if (res.headersSent) return res.end();
        handleError(res, error, 'Error generating Excel report');
    }
});

// Export as PDF: summary, college table, and the cameras that aren't working.
// For a single college (?collegeId=) it lists all of that college's cameras instead.
router.get('/export/pdf', authMiddleware, async (req, res) => {
    try {
        const days = parseDays(req.query.days);
        const { rows } = await buildRows(req.user, days);
        const { colleges, college } = selectForExport(req, rows);
        const summary = summarize(colleges);
        const detailCollegeIds = college ? [college.id] : colleges.filter(c => c.notWorking > 0).map(c => c.id);
        const detailCameras = await getCameraDetails(req.user, detailCollegeIds, days);
        const failing = detailCameras
            .filter(c => healthMonitor.FAILURE_STATUSES.includes(c.status))
            .sort((a, b) => a.collegeName.localeCompare(b.collegeName) || a.name.localeCompare(b.name));

        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${exportFileName(college, 'pdf')}`);
        doc.pipe(res);

        const left = doc.page.margins.left;
        const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 20;

        // Draws a table; columns: [{ label, width (fraction), get(row), color?(row) }]
        const drawTable = (columns, tableRows) => {
            const widths = columns.map(c => c.width * pageWidth);
            const padding = 4;

            const drawHeader = () => {
                const y = doc.y;
                doc.rect(left, y, pageWidth, 18).fill('#1E293B');
                let x = left;
                doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
                columns.forEach((col, i) => {
                    doc.text(col.label, x + padding, y + 5, { width: widths[i] - padding * 2, lineBreak: false, ellipsis: true });
                    x += widths[i];
                });
                doc.y = y + 18;
            };

            drawHeader();
            tableRows.forEach((row, rowIndex) => {
                doc.font('Helvetica').fontSize(8);
                const values = columns.map(col => String(col.get(row) ?? '-'));
                const height = Math.max(16, ...values.map((v, i) => doc.heightOfString(v, { width: widths[i] - padding * 2 }) + 8));

                if (doc.y + height > bottomLimit()) {
                    doc.addPage();
                    drawHeader();
                }

                const y = doc.y;
                if (rowIndex % 2 === 1) doc.rect(left, y, pageWidth, height).fill('#F1F5F9');
                let x = left;
                columns.forEach((col, i) => {
                    const color = col.color ? col.color(row) : null;
                    doc.font(color ? 'Helvetica-Bold' : 'Helvetica').fillColor(color ? '#' + color : '#1E293B');
                    doc.text(values[i], x + padding, y + 4, { width: widths[i] - padding * 2 });
                    x += widths[i];
                });
                doc.moveTo(left, y + height).lineTo(left + pageWidth, y + height).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
                doc.y = y + height;
            });
            doc.x = left;
        };

        const sectionTitle = (text) => {
            if (doc.y + 60 > bottomLimit()) doc.addPage();
            doc.moveDown(0.8);
            doc.font('Helvetica-Bold').fontSize(13).fillColor('#0F172A').text(text, left);
            doc.moveDown(0.4);
        };

        doc.font('Helvetica-Bold').fontSize(18).fillColor('#0F172A')
            .text(college ? `Connection Status: ${college.name}` : 'College Connection Status Report', left);
        if (college && college.address) doc.font('Helvetica').fontSize(10).fillColor('#334155').text(college.address);
        doc.font('Helvetica').fontSize(10).fillColor('#64748B')
            .text(`Generated ${formatDateTime(new Date())}  ·  All cameras checked since ${formatDateTime(summary.oldestCheckAt)}  ·  Uptime window ${days} day(s)`);
        doc.moveDown(0.8);

        const tiles = college ? [
            ['Status', COLLEGE_STATUS_LABELS[college.status], STATUS_COLORS[college.status]],
            ['Cameras Online', `${college.online} / ${college.activeCameras}`, STATUS_COLORS.online],
            ['Cameras Not Working', college.notWorking, STATUS_COLORS.offline],
            ['Health', college.health !== null ? `${college.health}%` : '-', '0F172A'],
            [`Uptime (${days}d)`, college.uptime !== null ? `${college.uptime}%` : '-', '0F172A'],
            [`Outages (${days}d)`, college.outages, '0F172A'],
            ['Not Working For', college.downSince ? formatDuration(college.downSince) : '-', college.downSince ? STATUS_COLORS.down : '0F172A']
        ] : [
            ['Colleges', summary.colleges, '0F172A'],
            ['Working', summary.working, STATUS_COLORS.working],
            ['Partially Working', summary.partial, STATUS_COLORS.partial],
            ['Not Working', summary.down, STATUS_COLORS.down],
            ['Cameras Online', `${summary.online} / ${summary.cameras - summary.disabled}`, STATUS_COLORS.online],
            ['Cameras Not Working', summary.notWorking, STATUS_COLORS.offline],
            [`Avg Uptime (${days}d)`, summary.uptime !== null ? `${summary.uptime}%` : '-', '0F172A']
        ];
        const tileGap = 8;
        const tileWidth = (pageWidth - tileGap * (tiles.length - 1)) / tiles.length;
        const tileY = doc.y;
        tiles.forEach(([label, value, color], i) => {
            const x = left + i * (tileWidth + tileGap);
            doc.roundedRect(x, tileY, tileWidth, 48, 6).lineWidth(1).strokeColor('#E2E8F0').stroke();
            doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(label, x + 8, tileY + 8, { width: tileWidth - 16 });
            doc.font('Helvetica-Bold').fontSize(String(value).length > 10 ? 11 : 16).fillColor('#' + color)
                .text(String(value), x + 8, tileY + 22, { width: tileWidth - 16, lineBreak: false, ellipsis: true });
        });
        doc.x = left;
        doc.y = tileY + 48;

        if (college) {
            sectionTitle(`Cameras (${detailCameras.length})`);
            if (detailCameras.length === 0) {
                doc.font('Helvetica').fontSize(10).fillColor('#64748B').text('No cameras registered for this college.', left);
            } else {
                drawTable([
                    { label: 'Camera', width: 0.13, get: r => r.name },
                    { label: 'Location', width: 0.1, get: r => r.location },
                    { label: 'IP : Port', width: 0.12, get: r => `${r.ipAddress}:${r.rtspPort}` },
                    { label: 'Device', width: 0.08, get: r => r.deviceName },
                    { label: 'Status', width: 0.1, get: r => CAMERA_STATUS_LABELS[r.status], color: r => STATUS_COLORS[r.status] },
                    { label: 'For', width: 0.06, get: r => r.status === 'disabled' ? '-' : formatDuration(r.statusSince) },
                    { label: `Uptime ${days}d`, width: 0.07, get: r => r.uptime !== null && r.status !== 'disabled' ? `${r.uptime}%` : '-' },
                    { label: 'Response', width: 0.075, get: r => r.latencyMs !== null ? `${r.latencyMs} ms` : '-' },
                    { label: 'Last Online', width: 0.1, get: r => formatDateTime(r.lastOnlineAt) },
                    { label: 'Details', width: 0.165, get: r => r.error || (r.rtspCode ? `RTSP ${r.rtspCode}` : '') }
                ], detailCameras);
            }
        } else {
            sectionTitle(`College Summary (${colleges.length})`);
            drawTable([
                { label: 'College', width: 0.27, get: r => r.name },
                { label: 'Status', width: 0.13, get: r => COLLEGE_STATUS_LABELS[r.status], color: r => STATUS_COLORS[r.status] },
                { label: 'Total', width: 0.06, get: r => r.totalCameras },
                { label: 'Online', width: 0.07, get: r => r.online },
                { label: 'Not Working', width: 0.09, get: r => r.notWorking },
                { label: 'Health', width: 0.07, get: r => r.health !== null ? `${r.health}%` : '-' },
                { label: `Uptime ${days}d`, width: 0.08, get: r => r.uptime !== null ? `${r.uptime}%` : '-' },
                { label: `Outages ${days}d`, width: 0.08, get: r => r.outages },
                { label: 'Down For', width: 0.07, get: r => r.downSince ? formatDuration(r.downSince) : '-' },
                { label: 'Last Checked', width: 0.08, get: r => formatDateTime(r.latestCheckAt) }
            ], colleges);

            sectionTitle(`Cameras Not Working (${failing.length})`);
            if (failing.length === 0) {
                doc.font('Helvetica').fontSize(10).fillColor('#16A34A').text('All checked cameras are responding.', left);
            } else {
                drawTable([
                    { label: 'College', width: 0.2, get: r => r.collegeName },
                    { label: 'Camera', width: 0.14, get: r => r.name },
                    { label: 'Location', width: 0.11, get: r => r.location },
                    { label: 'IP : Port', width: 0.12, get: r => `${r.ipAddress}:${r.rtspPort}` },
                    { label: 'Status', width: 0.11, get: r => CAMERA_STATUS_LABELS[r.status], color: r => STATUS_COLORS[r.status] },
                    { label: 'For', width: 0.07, get: r => formatDuration(r.statusSince) },
                    { label: 'Last Online', width: 0.1, get: r => formatDateTime(r.lastOnlineAt) },
                    { label: 'Details', width: 0.15, get: r => r.error }
                ], failing);
            }
        }

        const range = doc.bufferedPageRange();
        for (let i = 0; i < range.count; i++) {
            doc.switchToPage(range.start + i);
            doc.font('Helvetica').fontSize(8).fillColor('#94A3B8')
                .text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - doc.page.margins.bottom - 10, { width: pageWidth, align: 'right', lineBreak: false });
        }
        doc.end();
    } catch (error) {
        if (res.headersSent) return res.end();
        handleError(res, error, 'Error generating PDF report');
    }
});

module.exports = router;
