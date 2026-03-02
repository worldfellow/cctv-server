const express = require('express');
const router = express.Router();
const { College, User } = require('../models');
const authMiddleware = require('../middleware/auth');
const { Op } = require('sequelize');

// Get all colleges (paginated + search)
router.get('/', authMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || '';
        const offset = (page - 1) * limit;

        const whereClause = {};
        if (search) {
            whereClause.name = {
                [Op.like]: `%${search}%`
            };
        }
        if (req.query.activeOnly === 'true') {
            whereClause.isActive = true;
        }

        const { count, rows } = await College.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['createdAt', 'DESC']],
        });

        res.json({
            data: rows,
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit)
        });
    } catch (error) {
        console.error('Error fetching colleges:', error);
        res.status(500).json({ message: 'Error fetching colleges' });
    }
});

const exceljs = require('exceljs');
const multer = require('multer');

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Generate Excel Template for Bulk Upload of Colleges
router.get('/template/download', authMiddleware, async (req, res) => {
    try {
        const workbook = new exceljs.Workbook();
        const sheet = workbook.addWorksheet('Colleges');

        // Add headers to main sheet
        sheet.columns = [
            { header: 'College Name', key: 'name', width: 30 },
            { header: 'Address', key: 'address', width: 50 },
            { header: 'Contact Email', key: 'contactEmail', width: 30 }
        ];

        // Add a sample row
        sheet.addRow({
            name: 'Sample Engineering College',
            address: '123 University Ave, Tech City, ST 12345',
            contactEmail: 'contact@samplecollege.edu'
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=College_Bulk_Upload_Template.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error generating college template:', error);
        res.status(500).json({ message: 'Error generating template' });
    }
});

// Bulk Upload Colleges from Excel
router.post('/bulk-upload', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const workbook = new exceljs.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const sheet = workbook.getWorksheet('Colleges') || workbook.worksheets[0];

        if (!sheet) {
            return res.status(400).json({ message: 'Invalid Excel file structure' });
        }

        const collegesToCreate = [];
        const errors = [];

        sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header row

            const name = row.getCell(1).value?.toString().trim();
            const address = row.getCell(2).value?.toString().trim();
            const contactEmail = row.getCell(3).value?.toString().trim();

            // Skip entirely empty rows
            if (!name && !address && !contactEmail) return;

            // Name is required based on the College model
            if (!name) {
                errors.push(`Row ${rowNumber}: Missing required field (College Name)`);
                return;
            }

            // Primitive email validation if provided
            if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
                errors.push(`Row ${rowNumber}: Invalid email format for '${contactEmail}'`);
                return;
            }

            collegesToCreate.push({
                name,
                address: address || null,
                contactEmail: contactEmail || null
            });
        });

        if (errors.length > 0) {
            return res.status(400).json({ message: 'Validation failed', errors });
        }

        if (collegesToCreate.length === 0) {
            return res.status(400).json({ message: 'No valid data found in file' });
        }

        // Bulk insert
        await College.bulkCreate(collegesToCreate);

        res.status(201).json({
            message: `Successfully created ${collegesToCreate.length} colleges.`,
            count: collegesToCreate.length
        });
    } catch (error) {
        console.error('Error during college bulk upload:', error);
        res.status(500).json({ message: 'Error processing Excel file' });
    }
});

// Get all active colleges (unpaginated for dropdowns)
router.get('/active', authMiddleware, async (req, res) => {
    try {
        const colleges = await College.findAll({
            where: { isActive: true },
            order: [['name', 'ASC']],
            attributes: ['id', 'name']
        });
        res.json(colleges);
    } catch (error) {
        console.error('Error fetching active colleges:', error);
        res.status(500).json({ message: 'Error fetching active colleges' });
    }
});

// Get a single college
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const college = await College.findByPk(req.params.id, {
            include: [{ model: User, attributes: ['firstName', 'lastName', 'email', 'role'] }]
        });
        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }
        res.json(college);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching college' });
    }
});

// Create a college
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { name, address, contactEmail } = req.body;
        const college = await College.create({ name, address, contactEmail });
        res.status(201).json(college);
    } catch (error) {
        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({ message: error.errors[0].message });
        }
        res.status(500).json({ message: 'Error creating college' });
    }
});

// Update a college
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const college = await College.findByPk(req.params.id);
        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }
        const { name, address, contactEmail } = req.body;
        await college.update({ name, address, contactEmail });
        res.json(college);
    } catch (error) {
        res.status(500).json({ message: 'Error updating college' });
    }
});

// Delete a college
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const college = await College.findByPk(req.params.id);
        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }
        await college.destroy();
        res.json({ message: 'College deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting college' });
    }
});

// Toggle college active/inactive status
router.patch('/:id/toggle-status', authMiddleware, async (req, res) => {
    try {
        const college = await College.findByPk(req.params.id);
        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }
        await college.update({ isActive: !college.isActive });
        res.json(college);
    } catch (error) {
        console.error('Error toggling college status:', error);
        res.status(500).json({ message: 'Error toggling college status' });
    }
});

// Bulk update college status (activate/deactivate)
router.post('/bulk-status', authMiddleware, async (req, res) => {
    try {
        const { ids, isActive } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'Please provide an array of college IDs' });
        }
        if (typeof isActive !== 'boolean') {
            return res.status(400).json({ message: 'isActive must be a boolean value' });
        }
        await College.update({ isActive }, { where: { id: { [Op.in]: ids } } });
        res.json({ message: `${ids.length} college(s) ${isActive ? 'activated' : 'deactivated'} successfully` });
    } catch (error) {
        console.error('Error bulk updating college status:', error);
        res.status(500).json({ message: 'Error updating college statuses' });
    }
});

// Bulk delete colleges
router.post('/bulk-delete', authMiddleware, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'Please provide an array of college IDs' });
        }
        const deleted = await College.destroy({ where: { id: { [Op.in]: ids } } });
        res.json({ message: `${deleted} college(s) deleted successfully` });
    } catch (error) {
        console.error('Error bulk deleting colleges:', error);
        res.status(500).json({ message: 'Error deleting colleges' });
    }
});

module.exports = router;
