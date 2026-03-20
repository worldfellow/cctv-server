const express = require('express');
const router = express.Router();
const { SystemConfig } = require('../models');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Configure multer for logo uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const baseDir = process.env.FILE_LOCATION || path.join(__dirname, '../../../uploads');
        const logoDir = path.join(baseDir, 'config');
        if (!fs.existsSync(logoDir)) {
            fs.mkdirSync(logoDir, { recursive: true });
        }
        cb(null, logoDir);
    },
    filename: (req, file, cb) => {
        cb(null, `logo_${Date.now()}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ storage: storage });

// Publicly accessible route to get current configuration
router.get('/', async (req, res) => {
    try {
        const config = await SystemConfig.findOne();
        res.json(config);
    } catch (error) {
        console.error('Error fetching system config:', error);
        res.status(500).json({ error: 'Failed to fetch application settings' });
    }
});

// Protected route to update config (Role check should be added in middleware)
router.post('/', upload.single('logo'), async (req, res) => {
    try {
        const { appName, footerText } = req.body;
        let config = await SystemConfig.findOne();

        const updateData = {};
        if (appName) updateData.appName = appName;
        if (footerText) updateData.footerText = footerText;
        if (req.file) {
            updateData.logoUrl = `/uploads/config/${req.file.filename}`;
        }

        if (config) {
            await config.update(updateData);
        } else {
            config = await SystemConfig.create(updateData);
        }

        res.json(config);
    } catch (error) {
        console.error('Error updating system config:', error);
        res.status(500).json({ error: 'Failed to update application settings' });
    }
});

module.exports = router;
