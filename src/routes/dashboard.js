const express = require('express');
const router = express.Router();
const { Camera, College } = require('../models');
const { decrypt } = require('../utils/crypto');
const authMiddleware = require('../middleware/auth');
const streamManager = require('../services/streamManager');

// Get dashboard statistics (total, active, offline)
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const collegeId = req.query.collegeId;

        if (!collegeId) {
            return res.status(400).json({ message: 'College ID is required' });
        }

        const totalCameras = await Camera.count({ where: { collegeId } });
        const activeCameras = await Camera.count({ where: { collegeId, isActive: true } });
        const offlineCameras = totalCameras - activeCameras;

        res.json({
            total: totalCameras,
            active: activeCameras,
            offline: offlineCameras
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ message: 'Error fetching stats' });
    }
});

// Get paginated dashboard feeds for a college
router.get('/', authMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const collegeId = req.query.collegeId;
        const offset = (page - 1) * limit;

        if (!collegeId) {
            return res.status(400).json({ message: 'College ID is required' });
        }

        const { count, rows } = await Camera.findAndCountAll({
            where: {
                collegeId,
                isActive: true // Dashboard should show only active cameras
            },
            limit,
            offset,
            order: [['createdAt', 'ASC']],
            include: [{ model: College, attributes: ['name'] }]
        });

        const formattedData = [];
        for (const camera of rows) {
            const rawUsername = decrypt(camera.username) || '';
            const rawPassword = decrypt(camera.password) || '';

            // Construct RTSP URL for streamManager
            let rtspUrl = ``;

            if (camera.deviceId) {
                const device = await require('../models').Device.findByPk(camera.deviceId);
                if (device && device.rtspLink) {
                    rtspUrl = device.rtspLink
                        .replace(/\$userTemplate/g, rawUsername)
                        .replace(/\$passwordTemplate/g, rawPassword)
                        .replace(/\$ipTemplate/g, camera.ipAddress)
                        .replace(/\$portTemplate/g, camera.rtspPort.toString())
                        .replace(/\$channelTemplate/g, camera.channel);
                }
            }

            let wsPort;
            try {
                wsPort = streamManager.startStream(camera.id, rtspUrl, 'low');
            } catch (err) {
                console.error(`Failed to start stream for camera ${camera.id}:`, err);
            }

            const host = req.get('host') || 'localhost';
            const protocol = (req.get('X-Forwarded-Proto') || req.protocol) === 'https' ? 'wss' : 'ws';

            formattedData.push({
                id: camera.id,
                name: camera.name,
                location: camera.location,
                status: 'online',
                thumbnail: 'https://images.unsplash.com/photo-1557597774-9d2739f85a94?q=80&w=800&auto=format&fit=crop',
                wsUrl: wsPort ? `${protocol}://${host}/api/stream/${camera.id}_low` : null,
                collegeName: camera.College ? camera.College.name : null
            });

            // stagger delay to ensure clean process start
            if (rows.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        res.json({
            data: formattedData,
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit)
        });
    } catch (error) {
        console.error('Error fetching dashboard feeds:', error);
        res.status(500).json({ message: 'Error fetching dashboard feeds' });
    }
});

// Restart a specific camera stream
router.post('/restart-stream/:id', authMiddleware, async (req, res) => {
    try {
        const cameraId = req.params.id;
        const quality = req.query.quality || 'low'; // Default to low for dashboard

        const camera = await Camera.findByPk(cameraId);
        if (!camera) {
            return res.status(404).json({ message: 'Camera not found' });
        }

        const rawUsername = decrypt(camera.username) || '';
        const rawPassword = decrypt(camera.password) || '';
        let rtspUrl = ``;

        if (camera.deviceId) {
            const device = await require('../models').Device.findByPk(camera.deviceId);
            if (device && device.rtspLink) {
                rtspUrl = device.rtspLink
                    .replace(/\$userTemplate/g, rawUsername)
                    .replace(/\$passwordTemplate/g, rawPassword)
                    .replace(/\$ipTemplate/g, camera.ipAddress)
                    .replace(/\$portTemplate/g, camera.rtspPort.toString())
                    .replace(/\$channelTemplate/g, camera.channel);
            }
        }

        console.log(`[Dashboard] Request to restart stream for camera ${cameraId} (${quality})`);

        await streamManager.restartStream(cameraId, rtspUrl, quality);

        const host = req.get('host') || 'localhost';
        const protocol = (req.get('X-Forwarded-Proto') || req.protocol) === 'https' ? 'wss' : 'ws';
        const wsUrl = `${protocol}://${host}/api/stream/${cameraId}_${quality}`;

        res.json({
            message: 'Stream restart initiated',
            wsUrl: wsUrl
        });
    } catch (error) {
        console.error('Error restarting stream:', error);
        res.status(500).json({ message: 'Error restarting stream' });
    }
});

module.exports = router;
