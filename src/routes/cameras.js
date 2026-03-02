const express = require('express');
const router = express.Router();
const { Camera, College } = require('../models');
const { encrypt, decrypt } = require('../utils/crypto');
const authMiddleware = require('../middleware/auth');
const { Op } = require('sequelize');
const exceljs = require('exceljs');
const multer = require('multer');
const streamManager = require('../services/streamManager');

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Create a camera
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { collegeId, name, location, ipAddress, rtspPort, channel, username, password, isActive } = req.body;

        // Validate college
        const college = await College.findByPk(collegeId);
        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }

        const camera = await Camera.create({
            collegeId,
            name,
            location,
            ipAddress,
            rtspPort: rtspPort || 554,
            channel,
            username: encrypt(username), // Encrypt sensitive info
            password: encrypt(password), // Encrypt sensitive info
            isActive: isActive !== undefined ? isActive : true
        });

        // Send back unencrypted credentials for the UI
        const cameraResponse = camera.toJSON();
        cameraResponse.username = username || '';
        cameraResponse.password = password || '';

        res.status(201).json(cameraResponse);
    } catch (error) {
        console.error('Error creating camera:', error);
        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({ message: error.errors[0].message });
        }
        res.status(500).json({ message: 'Error creating camera' });
    }
});

// Generate Excel Template for Bulk Upload
router.get('/template/download', authMiddleware, async (req, res) => {
    try {
        const colleges = await College.findAll({ attributes: ['name'] });
        const workbook = new exceljs.Workbook();
        const sheet = workbook.addWorksheet('Cameras');

        // Config sheet for dropdown lists (preventing >255 character limit in data validation)
        const configSheet = workbook.addWorksheet('Config');
        configSheet.state = 'hidden';

        colleges.forEach((college, index) => {
            configSheet.getCell(`A${index + 1}`).value = college.name;
        });

        const statusList = ['Active', 'Inactive'];
        statusList.forEach((status, index) => {
            configSheet.getCell(`B${index + 1}`).value = status;
        });

        // Add headers to main sheet
        sheet.columns = [
            { header: 'College Name', key: 'collegeName', width: 30 },
            { header: 'Camera Name', key: 'name', width: 25 },
            { header: 'Location', key: 'location', width: 25 },
            { header: 'IP Address', key: 'ipAddress', width: 20 },
            { header: 'RTSP Port', key: 'rtspPort', width: 15 },
            { header: 'Channel', key: 'channel', width: 15 },
            { header: 'Username', key: 'username', width: 20 },
            { header: 'Password', key: 'password', width: 20 },
            { header: 'Status', key: 'status', width: 15 }
        ];

        const collegeCount = colleges.length || 1;

        // Apply validation to 100 rows
        for (let i = 2; i <= 101; i++) {
            if (colleges.length > 0) {
                sheet.getCell(`A${i}`).dataValidation = {
                    type: 'list',
                    allowBlank: true,
                    formulae: [`Config!$A$1:$A$${collegeCount}`]
                };
            }
            sheet.getCell(`I${i}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`Config!$B$1:$B$2`]
            };
        }

        // Add a sample row (optional)
        if (colleges.length > 0) {
            sheet.addRow({
                collegeName: colleges[0].name,
                name: 'Main Entrance',
                location: 'Gate A',
                ipAddress: '192.168.1.100',
                rtspPort: 554,
                channel: '1',
                username: 'admin',
                password: 'password123',
                status: 'Active'
            });
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Camera_Bulk_Upload_Template.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error generating template:', error);
        res.status(500).json({ message: 'Error generating template' });
    }
});

// Bulk Upload Cameras from Excel
router.post('/bulk-upload', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const workbook = new exceljs.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const sheet = workbook.getWorksheet('Cameras') || workbook.worksheets[0];

        if (!sheet) {
            return res.status(400).json({ message: 'Invalid Excel file structure' });
        }

        const colleges = await College.findAll();
        const collegeMap = {};
        colleges.forEach(c => {
            collegeMap[c.name.trim().toLowerCase()] = c.id;
        });

        const camerasToCreate = [];
        const errors = [];

        sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header

            const collegeName = row.getCell(1).value?.toString().trim();
            const cameraName = row.getCell(2).value?.toString().trim();
            const location = row.getCell(3).value?.toString().trim();
            const ipAddress = row.getCell(4).value?.toString().trim();
            const rtspPort = parseInt(row.getCell(5).value, 10) || 554;
            const channel = row.getCell(6).value?.toString().trim();
            const username = row.getCell(7).value?.toString().trim();
            const password = row.getCell(8).value?.toString().trim();
            const status = row.getCell(9).value?.toString().trim() || 'Active';

            // Skip entirely empty rows
            if (!collegeName && !ipAddress && !username && !cameraName) return;

            const collegeId = collegeName ? collegeMap[collegeName.toLowerCase()] : null;

            if (!collegeId) {
                errors.push(`Row ${rowNumber}: College '${collegeName}' not found`);
                return;
            }
            if (!cameraName || !ipAddress || !channel || !username || !password) {
                errors.push(`Row ${rowNumber}: Missing required fields (Name, IP, Channel, Username, Password)`);
                return;
            }

            camerasToCreate.push({
                collegeId,
                name: cameraName,
                location: location || null,
                ipAddress,
                rtspPort,
                channel,
                username: encrypt(username),
                password: encrypt(password),
                isActive: status.toLowerCase() === 'active'
            });
        });

        if (errors.length > 0) {
            return res.status(400).json({ message: 'Validation failed', errors });
        }

        if (camerasToCreate.length === 0) {
            return res.status(400).json({ message: 'No valid data found in file' });
        }

        // Bulk insert
        await Camera.bulkCreate(camerasToCreate);

        res.status(201).json({
            message: `Successfully created ${camerasToCreate.length} cameras.`,
            count: camerasToCreate.length
        });
    } catch (error) {
        console.error('Error during bulk upload:', error);
        res.status(500).json({ message: 'Error processing Excel file' });
    }
});

// Get all cameras (paginated)
router.get('/', authMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const collegeId = req.query.collegeId;
        const offset = (page - 1) * limit;

        const whereClause = {};
        if (collegeId) {
            whereClause.collegeId = collegeId;
        }

        const { count, rows } = await Camera.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['createdAt', 'DESC']],
            include: [{ model: College, attributes: ['name'] }]
        });

        const formattedData = rows.map(camera => {
            const rawUsername = decrypt(camera.username) || '';
            const rawPassword = decrypt(camera.password) || '';

            return {
                id: camera.id,
                name: camera.name,
                location: camera.location,
                ipAddress: camera.ipAddress,
                rtspPort: camera.rtspPort,
                channel: camera.channel,
                status: camera.isActive ? 'online' : 'offline',
                isActive: camera.isActive,
                thumbnail: 'https://images.unsplash.com/photo-1557597774-9d2739f85a94?q=80&w=800&auto=format&fit=crop', // Placeholder thumbnail
                collegeId: camera.collegeId,
                collegeName: camera.College ? camera.College.name : null,
                username: rawUsername,
                password: rawPassword,
                createdAt: camera.createdAt,
                updatedAt: camera.updatedAt
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
        console.error('Error fetching cameras:', error);
        res.status(500).json({ message: 'Error fetching cameras' });
    }
});

// Start stream proxy for a camera
router.post('/:id/start-stream', authMiddleware, async (req, res) => {
    try {
        const camera = await Camera.findByPk(req.params.id);
        if (!camera) return res.status(404).json({ message: 'Camera not found' });

        const rawUsername = decrypt(camera.username) || '';
        const rawPassword = decrypt(camera.password) || '';
        const rtspUrl = `rtsp://${encodeURIComponent(rawUsername)}:${encodeURIComponent(rawPassword)}@${camera.ipAddress}:${camera.rtspPort}/cam/realmonitor?channel=${camera.channel}&subtype=0`;

        // Start stream and get the WebSocket port
        const wsPort = streamManager.startStream(camera.id, rtspUrl);

        // Calculate host based on request headers (assuming same domain for WS)
        const host = req.hostname || 'localhost';

        res.json({
            message: 'Stream started successfully',
            wsUrl: `ws://${host}:${wsPort}`
        });

    } catch (error) {
        console.error('Error starting stream proxy:', error);
        res.status(500).json({ message: 'Error starting stream proxy', error: error.message });
    }
});

// Get a single camera
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const camera = await Camera.findByPk(req.params.id, {
            include: [{ model: College, attributes: ['name'] }]
        });

        if (!camera) {
            return res.status(404).json({ message: 'Camera not found' });
        }

        const rawUsername = decrypt(camera.username) || '';
        const rawPassword = decrypt(camera.password) || '';

        const formattedData = {
            id: camera.id,
            name: camera.name,
            location: camera.location,
            ipAddress: camera.ipAddress,
            rtspPort: camera.rtspPort,
            channel: camera.channel,
            status: camera.isActive ? 'online' : 'offline',
            isActive: camera.isActive,
            thumbnail: 'https://images.unsplash.com/photo-1557597774-9d2739f85a94?q=80&w=800&auto=format&fit=crop',
            collegeId: camera.collegeId,
            collegeName: camera.College ? camera.College.name : null,
            username: rawUsername,
            password: rawPassword,
            createdAt: camera.createdAt,
            updatedAt: camera.updatedAt
        };

        res.json(formattedData);
    } catch (error) {
        console.error('Error fetching camera:', error);
        res.status(500).json({ message: 'Error fetching camera' });
    }
});

// Update a camera
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const camera = await Camera.findByPk(req.params.id);
        if (!camera) {
            return res.status(404).json({ message: 'Camera not found' });
        }

        const { name, location, ipAddress, rtspPort, channel, username, password, isActive } = req.body;

        const updateData = {};
        if (name) updateData.name = name;
        if (location !== undefined) updateData.location = location;
        if (ipAddress) updateData.ipAddress = ipAddress;
        if (rtspPort) updateData.rtspPort = rtspPort;
        if (channel) updateData.channel = channel;
        if (username !== undefined) updateData.username = encrypt(username);
        if (password !== undefined) updateData.password = encrypt(password);
        if (isActive !== undefined) updateData.isActive = isActive;

        await camera.update(updateData);

        const cameraResponse = camera.toJSON();
        cameraResponse.username = username !== undefined ? username : (decrypt(camera.username) || '');
        cameraResponse.password = password !== undefined ? password : (decrypt(camera.password) || '');

        res.json(cameraResponse);
    } catch (error) {
        console.error('Error updating camera:', error);
        res.status(500).json({ message: 'Error updating camera' });
    }
});

// Delete a camera
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const camera = await Camera.findByPk(req.params.id);
        if (!camera) {
            return res.status(404).json({ message: 'Camera not found' });
        }
        await camera.destroy();
        res.json({ message: 'Camera deleted successfully' });
    } catch (error) {
        console.error('Error deleting camera:', error);
        res.status(500).json({ message: 'Error deleting camera' });
    }
});

// Toggle camera active/inactive status
router.patch('/:id/toggle-status', authMiddleware, async (req, res) => {
    try {
        const camera = await Camera.findByPk(req.params.id);
        if (!camera) {
            return res.status(404).json({ message: 'Camera not found' });
        }
        await camera.update({ isActive: !camera.isActive });
        res.json({ id: camera.id, isActive: camera.isActive });
    } catch (error) {
        console.error('Error toggling camera status:', error);
        res.status(500).json({ message: 'Error toggling camera status' });
    }
});

// Bulk update camera status (activate/deactivate)
router.post('/bulk-status', authMiddleware, async (req, res) => {
    try {
        const { ids, isActive } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'Please provide an array of camera IDs' });
        }
        if (typeof isActive !== 'boolean') {
            return res.status(400).json({ message: 'isActive must be a boolean value' });
        }
        await Camera.update({ isActive }, { where: { id: { [Op.in]: ids } } });
        res.json({ message: `${ids.length} camera(s) ${isActive ? 'activated' : 'deactivated'} successfully` });
    } catch (error) {
        console.error('Error bulk updating camera status:', error);
        res.status(500).json({ message: 'Error updating camera statuses' });
    }
});

// Bulk delete cameras
router.post('/bulk-delete', authMiddleware, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'Please provide an array of camera IDs' });
        }
        const deleted = await Camera.destroy({ where: { id: { [Op.in]: ids } } });
        res.json({ message: `${deleted} camera(s) deleted successfully` });
    } catch (error) {
        console.error('Error bulk deleting cameras:', error);
        res.status(500).json({ message: 'Error deleting cameras' });
    }
});

module.exports = router;
