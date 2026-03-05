const express = require('express');
const router = express.Router();
const { Screenshot } = require('../models');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('../middleware/auth');

// Ensure upload directory exists
const uploadDir = process.env.SCREENSHOT_PATH;

if (!uploadDir) {
    console.error('CRITICAL: SCREENSHOT_PATH environment variable is not set.');
} else if (!fs.existsSync(uploadDir)) {
    try {
        fs.mkdirSync(uploadDir, { recursive: true });
    } catch (err) {
        console.error(`Failed to create screenshot directory at ${uploadDir}:`, err.message);
    }
}

router.post('/', authMiddleware, async (req, res) => {
    try {
        const { image, collegeName, cameraName, location, date, time } = req.body;

        if (!uploadDir) {
            return res.status(500).json({ error: 'Screenshot storage path not configured on server' });
        }

        if (!image) {
            return res.status(400).json({ error: 'Image data is required' });
        }

        // Handle base64 image
        const base64Data = image.replace(/^data:image\/png;base64,/, "");

        // Create subfolders based on College and Date
        const sanitizedCollege = (collegeName || 'Unknown').replace(/[^a-z0-9]/gi, '_').trim();
        const sanitizedDate = (date || new Date().toLocaleDateString()).replace(/[^a-z0-9]/gi, '-');

        const subFolder = path.join(sanitizedCollege, sanitizedDate);
        const fullSubFolderPath = path.join(uploadDir, subFolder);

        if (!fs.existsSync(fullSubFolderPath)) {
            fs.mkdirSync(fullSubFolderPath, { recursive: true });
        }

        const fileName = `screenshot_${cameraName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.png`;
        const filePath = path.join(fullSubFolderPath, fileName);

        fs.writeFileSync(filePath, base64Data, 'base64');

        const screenshot = await Screenshot.create({
            collegeName,
            cameraName,
            location,
            date,
            time,
            imageUrl: `/uploads/screenshots/${subFolder.replace(/\\/g, '/')}/${fileName}`
        });

        res.status(201).json(screenshot);
    } catch (error) {
        console.error('Error saving screenshot:', error);
        res.status(500).json({ error: 'Failed to save screenshot' });
    }
});

router.get('/', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 10, collegeName, cameraName, startDate, endDate } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const { Op } = require('sequelize');

        const where = {};
        if (collegeName) where.collegeName = collegeName;

        // Apply restrictions for non-SUPER_ADMIN
        if (req.user.role !== 'SUPER_ADMIN' && !req.user.allowedColleges.includes('ALL')) {
            const { User, College } = require('../models');
            const allowedColleges = await College.findAll({
                where: { id: { [Op.in]: req.user.allowedColleges } },
                attributes: ['name']
            });
            const allowedNames = allowedColleges.map(c => c.name);

            if (collegeName) {
                if (!allowedNames.includes(collegeName)) {
                    return res.status(403).json({ error: 'Access denied to this college' });
                }
            } else {
                where.collegeName = { [Op.in]: allowedNames };
            }
        }

        if (cameraName) where.cameraName = { [Op.like]: `%${cameraName}%` };

        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt[Op.gte] = new Date(startDate);
            if (endDate) where.createdAt[Op.lte] = new Date(new Date(endDate).setHours(23, 59, 59, 999));
        }

        const { count, rows } = await Screenshot.findAndCountAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset: offset
        });

        res.json({
            totalItems: count,
            screenshots: rows,
            totalPages: Math.ceil(count / parseInt(limit)),
            currentPage: parseInt(page)
        });
    } catch (error) {
        console.error('Error fetching screenshots:', error);
        res.status(500).json({ error: 'Failed to fetch screenshots' });
    }
});

router.post('/delete', authMiddleware, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Please provide an array of screenshot IDs' });
        }

        const { Op } = require('sequelize');
        const screenshots = await Screenshot.findAll({
            where: { id: { [Op.in]: ids } }
        });

        const deletedIds = [];
        const failedFiles = [];

        for (const screenshot of screenshots) {
            try {
                // Determine absolute path to the file
                const relativePath = screenshot.imageUrl.replace('/uploads/screenshots/', '');
                const filePath = path.join(uploadDir, relativePath);

                console.log(`Attempting to delete file: ${filePath}`);

                // Check if file exists and delete it
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                } else {
                    console.warn(`File not found, proceeding with DB deletion: ${filePath}`);
                }

                // Delete DB record
                await screenshot.destroy();
                deletedIds.push(screenshot.id);
            } catch (err) {
                console.error(`Failed to delete screenshot ${screenshot.id}:`, err);
                failedFiles.push(screenshot.id);
            }
        }

        if (failedFiles.length > 0 && deletedIds.length === 0) {
            return res.status(500).json({ error: 'Failed to delete selected screenshots' });
        }

        res.json({
            message: `Successfully deleted ${deletedIds.length} screenshots.`,
            deletedIds,
            failedFiles
        });

    } catch (error) {
        console.error('Error deleting screenshots:', error);
        res.status(500).json({ error: 'An error occurred while deleting screenshots' });
    }
});

module.exports = router;
