const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { Device, College } = require('../models');

// Check for SUPER_ADMIN role for all device routes
router.use(authMiddleware, (req, res, next) => {
    if (req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ message: 'Access denied: SUPER_ADMIN role required' });
    }
    next();
});

// Create a device
router.post('/', async (req, res) => {
    try {
        const { deviceName, rtspLink } = req.body;

        const device = await Device.create({
            deviceName,
            rtspLink,
        });

        res.status(201).json(device);
    } catch (error) {
        console.error('Error creating device:', error);
        res.status(500).json({ message: 'Error creating device' });
    }
});

// Get all devices
router.get('/', async (req, res) => {
    try {
        const devices = await Device.findAll();
        res.json(devices);
    } catch (error) {
        console.error('Error fetching devices:', error);
        res.status(500).json({ message: 'Error fetching devices' });
    }
});

// Update a device
router.put('/:id', async (req, res) => {
    try {
        const device = await Device.findByPk(req.params.id);
        if (!device) return res.status(404).json({ message: 'Device not found' });

        await device.update(req.body);
        res.json(device);
    } catch (error) {
        console.error('Error updating device:', error);
        res.status(500).json({ message: 'Error updating device' });
    }
});

// Delete a device
router.delete('/:id', async (req, res) => {
    try {
        const device = await Device.findByPk(req.params.id);
        if (!device) return res.status(404).json({ message: 'Device not found' });

        await device.destroy();
        res.json({ message: 'Device deleted' });
    } catch (error) {
        console.error('Error deleting device:', error);
        res.status(500).json({ message: 'Error deleting device' });
    }
});

module.exports = router;
