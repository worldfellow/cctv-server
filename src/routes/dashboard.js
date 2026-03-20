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
            const rtspUrl = `rtsp://${rawUsername}:${rawPassword}@${camera.ipAddress}:${camera.rtspPort}/Streaming/Channels/${camera.channel}`;
            
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

module.exports = router;
