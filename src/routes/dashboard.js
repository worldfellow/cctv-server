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

        const formattedData = rows.map(camera => {
            const rawUsername = decrypt(camera.username) || '';
            const rawPassword = decrypt(camera.password) || '';

            console.log(rawUsername);
            console.log(rawPassword);
            console.log(camera.ipAddress);
            console.log(camera.rtspPort);
            console.log(camera.channel);

            // Construct RTSP URL for streamManager
            const rtspUrl = `rtsp://${rawUsername}:${rawPassword}@${camera.ipAddress}:${camera.rtspPort}/Streaming/Channels/${camera.channel}`;
            console.log(rtspUrl);
            // Note: In a real production scenario, we might want to start streams on demand 
            // but for "autoplay" dashboard requirement, we ensure they are ready.
            // However, starting 20 streams at once might be heavy.
            // We'll return the wsUrl and the client component will trigger the start if needed,
            // or we start it here. Let's start it here as per "autoplay" requirement.

            let wsPort;
            try {
                wsPort = streamManager.startStream(camera.id, rtspUrl, 'low');
            } catch (err) {
                console.error(`Failed to start stream for camera ${camera.id}:`, err);
            }

            const host = req.get('host') || 'localhost';

            return {
                id: camera.id,
                name: camera.name,
                location: camera.location,
                status: 'online',
                thumbnail: 'https://images.unsplash.com/photo-1557597774-9d2739f85a94?q=80&w=800&auto=format&fit=crop',
                wsUrl: wsPort ? `ws://${host.split(':')[0]}:${wsPort}` : null,
                collegeName: camera.College ? camera.College.name : null
            };
        });

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

module.exports = router;
