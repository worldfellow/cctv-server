const express = require('express');
const router = express.Router();
const { College, User } = require('../models');
const authMiddleware = require('../middleware/auth');
const { Op } = require('sequelize');

// Middleware to check if user has permission to perform a specific action
const mobileRegex = /^\d{10}$/;

// Excel may hand back the mobile as a number; normalise to a trimmed string
const normalizeMobile = (v) => (v === null || v === undefined ? '' : String(v).trim());

const checkActionPermission = (action) => {
    return (req, res, next) => {
        if (req.user.role === 'SUPER_ADMIN') {
            return next();
        }
        if (req.user.permissions && req.user.permissions.actions && req.user.permissions.actions.includes(action)) {
            return next();
        }
        return res.status(403).json({ message: `Access denied: Action permission '${action}' required.` });
    };
};

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

        // Apply restrictions for non-SUPER_ADMIN
        if (req.user.role !== 'SUPER_ADMIN' && !req.user.allowedColleges.includes('ALL')) {
            const allowed = req.user.allowedColleges || [];
            whereClause.id = { [Op.in]: allowed };
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
router.get('/template/download', authMiddleware, checkActionPermission('college_create'), async (req, res) => {
    try {
        const workbook = new exceljs.Workbook();
        const sheet = workbook.addWorksheet('Colleges');

        // Add headers to main sheet
        sheet.columns = [
            { header: 'College Name', key: 'name', width: 30 },
            { header: 'Address', key: 'address', width: 50 },
            { header: 'Contact Email', key: 'contactEmail', width: 30 },
            { header: 'Mobile No', key: 'mobileNo', width: 20 },
            { header: 'Camera Personnel Name', key: 'cameraPersonnelName', width: 30 }
        ];

        // Add a sample row
        sheet.addRow({
            name: 'Sample Engineering College',
            address: '123 University Ave, Tech City, ST 12345',
            contactEmail: 'contact@samplecollege.edu',
            mobileNo: '9876543210',
            cameraPersonnelName: 'John Doe'
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
router.post('/bulk-upload', authMiddleware, checkActionPermission('college_create'), upload.single('file'), async (req, res) => {
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
            const mobileNo = normalizeMobile(row.getCell(4).value);
            const cameraPersonnelName = row.getCell(5).value?.toString().trim();

            // Skip entirely empty rows
            if (!name && !address && !contactEmail && !mobileNo && !cameraPersonnelName) return;

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

            if (!mobileNo) {
                errors.push(`Row ${rowNumber}: Missing required field (Mobile No)`);
                return;
            }
            if (!mobileRegex.test(mobileNo)) {
                errors.push(`Row ${rowNumber}: Mobile No must be exactly 10 digits ('${mobileNo}')`);
                return;
            }

            collegesToCreate.push({
                name,
                address: address || null,
                contactEmail: contactEmail || null,
                mobileNo,
                cameraPersonnelName: cameraPersonnelName || null
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

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Colleges the current user is allowed to see/edit
const scopedCollegeWhere = (user) => {
    if (user.role !== 'SUPER_ADMIN' && !(user.allowedColleges || []).includes('ALL')) {
        return { id: { [Op.in]: user.allowedColleges || [] } };
    }
    return {};
};

// Cell value -> trimmed string (handles hyperlink/rich-text cells from Excel)
const cellText = (cell) => {
    const v = cell.value;
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
        if (v.text !== undefined) return String(v.text).trim();
        if (v.richText) return v.richText.map(t => t.text).join('').trim();
        if (v.result !== undefined) return String(v.result).trim();
    }
    return String(v).trim();
};

// Export existing colleges to Excel for bulk editing
router.get('/bulk-export', authMiddleware, checkActionPermission('college_edit'), async (req, res) => {
    try {
        const colleges = await College.findAll({
            where: scopedCollegeWhere(req.user),
            order: [['name', 'ASC']]
        });

        const workbook = new exceljs.Workbook();
        const sheet = workbook.addWorksheet('Colleges');
        sheet.columns = [
            { header: 'College ID', key: 'id', width: 40 },
            { header: 'College Name', key: 'name', width: 30 },
            { header: 'Address', key: 'address', width: 50 },
            { header: 'Contact Email', key: 'contactEmail', width: 30 },
            { header: 'Status', key: 'status', width: 15 },
            { header: 'Mobile No', key: 'mobileNo', width: 20 },
            { header: 'Camera Personnel Name', key: 'cameraPersonnelName', width: 30 }
        ];
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };

        colleges.forEach(c => sheet.addRow({
            id: c.id,
            name: c.name,
            address: c.address || '',
            contactEmail: c.contactEmail || '',
            status: c.isActive ? 'Active' : 'Inactive',
            mobileNo: c.mobileNo || '',
            cameraPersonnelName: c.cameraPersonnelName || ''
        }));

        // Lock the ID column visually and add a Status dropdown
        sheet.getColumn(1).font = { color: { argb: 'FF808080' } };
        for (let i = 2; i <= colleges.length + 1; i++) {
            sheet.getCell(`E${i}`).dataValidation = {
                type: 'list',
                allowBlank: false,
                formulae: ['"Active,Inactive"']
            };
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=College_Bulk_Edit_${new Date().toISOString().split('T')[0]}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error during college bulk export:', error);
        res.status(500).json({ message: 'Error generating export' });
    }
});

// Bulk update colleges from an edited Excel export (matched by College ID)
router.post('/bulk-update', authMiddleware, checkActionPermission('college_edit'), upload.single('file'), async (req, res) => {
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

        const existing = await College.findAll({ where: scopedCollegeWhere(req.user) });
        const existingMap = new Map(existing.map(c => [c.id, c]));

        const updates = [];
        const errors = [];
        const seen = new Set();

        sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;

            const id = cellText(row.getCell(1));
            const name = cellText(row.getCell(2));
            const address = cellText(row.getCell(3));
            const contactEmail = cellText(row.getCell(4));
            const status = cellText(row.getCell(5));
            const mobileNo = cellText(row.getCell(6));
            const cameraPersonnelName = cellText(row.getCell(7));

            if (!id && !name && !address && !contactEmail && !status && !mobileNo && !cameraPersonnelName) return;

            if (!id) {
                errors.push(`Row ${rowNumber}: Missing College ID (use Bulk Import to add new colleges)`);
                return;
            }
            if (seen.has(id)) {
                errors.push(`Row ${rowNumber}: Duplicate College ID '${id}'`);
                return;
            }
            seen.add(id);

            if (!existingMap.has(id)) {
                errors.push(`Row ${rowNumber}: College ID '${id}' not found or not permitted`);
                return;
            }
            if (!name) {
                errors.push(`Row ${rowNumber}: College Name is required`);
                return;
            }
            if (contactEmail && !emailRegex.test(contactEmail)) {
                errors.push(`Row ${rowNumber}: Invalid email format for '${contactEmail}'`);
                return;
            }
            if (!mobileRegex.test(mobileNo)) {
                errors.push(`Row ${rowNumber}: Mobile No is required and must be exactly 10 digits`);
                return;
            }
            const statusLower = status.toLowerCase();
            if (status && statusLower !== 'active' && statusLower !== 'inactive') {
                errors.push(`Row ${rowNumber}: Status must be 'Active' or 'Inactive'`);
                return;
            }

            const data = {
                name,
                address: address || null,
                contactEmail: contactEmail || null,
                mobileNo,
                cameraPersonnelName: cameraPersonnelName || null
            };
            if (status) data.isActive = statusLower === 'active';
            updates.push({ id, data });
        });

        if (errors.length > 0) {
            return res.status(400).json({ message: 'Validation failed', errors });
        }
        if (updates.length === 0) {
            return res.status(400).json({ message: 'No valid data found in file' });
        }

        // Apply atomically; skip rows that did not change
        let changed = 0;
        await College.sequelize.transaction(async (transaction) => {
            for (const { id, data } of updates) {
                const college = existingMap.get(id);
                college.set(data);
                if (college.changed()) {
                    await college.save({ transaction });
                    changed++;
                }
            }
        });

        res.json({
            message: `Processed ${updates.length} rows: ${changed} updated, ${updates.length - changed} unchanged.`,
            details: { updated: changed, unchanged: updates.length - changed }
        });
    } catch (error) {
        console.error('Error during college bulk update:', error);
        res.status(500).json({ message: 'Error processing Excel file' });
    }
});

// Get all active colleges (unpaginated for dropdowns)
router.get('/active', authMiddleware, async (req, res) => {
    try {
        const whereClause = { isActive: true };

        // Apply restrictions for non-SUPER_ADMIN
        if (req.user.role !== 'SUPER_ADMIN' && !req.user.allowedColleges.includes('ALL')) {
            const allowed = req.user.allowedColleges || [];
            whereClause.id = { [Op.in]: allowed };
        }

        const colleges = await College.findAll({
            where: whereClause,
            order: [['name', 'ASC']],
            attributes: ['id', 'name', 'address']
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
router.post('/', authMiddleware, checkActionPermission('college_create'), async (req, res) => {
    try {
        const { name, address, contactEmail, cameraPersonnelName } = req.body;
        const mobileNo = normalizeMobile(req.body.mobileNo);
        if (!mobileRegex.test(mobileNo)) {
            return res.status(400).json({ message: 'Mobile number is required and must be exactly 10 digits' });
        }
        const college = await College.create({ name, address, contactEmail, mobileNo, cameraPersonnelName });
        res.status(201).json(college);
    } catch (error) {
        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({ message: error.errors[0].message });
        }
        res.status(500).json({ message: 'Error creating college' });
    }
});

// Update a college
router.put('/:id', authMiddleware, checkActionPermission('college_edit'), async (req, res) => {
    try {
        const college = await College.findByPk(req.params.id);
        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }
        const { name, address, contactEmail, cameraPersonnelName } = req.body;
        const mobileNo = normalizeMobile(req.body.mobileNo);
        if (!mobileRegex.test(mobileNo)) {
            return res.status(400).json({ message: 'Mobile number is required and must be exactly 10 digits' });
        }
        await college.update({ name, address, contactEmail, mobileNo, cameraPersonnelName });
        res.json(college);
    } catch (error) {
        res.status(500).json({ message: 'Error updating college' });
    }
});

// Delete a college
router.delete('/:id', authMiddleware, checkActionPermission('college_delete'), async (req, res) => {
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
router.patch('/:id/toggle-status', authMiddleware, checkActionPermission('college_edit'), async (req, res) => {
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
router.post('/bulk-status', authMiddleware, checkActionPermission('college_bulk'), async (req, res) => {
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
router.post('/bulk-delete', authMiddleware, checkActionPermission('college_bulk'), async (req, res) => {
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
