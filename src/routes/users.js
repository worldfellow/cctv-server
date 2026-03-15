const express = require('express');
const router = express.Router();
const { User, College, Role } = require('../models');
const authMiddleware = require('../middleware/auth');
const keycloakService = require('../services/keycloak.service');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const exceljs = require('exceljs');
const multer = require('multer');

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// API to save super_admin without authorization header
router.post('/save-super-admin', async (req, res) => {
    try {
        const { firstName, lastName, email, mobileNo, password } = req.body;

        if (!email || !password || !firstName || !lastName || !mobileNo) {
            return res.status(400).json({ message: 'Missing required fields: firstName, lastName, email, mobileNo, password' });
        }

        // 1. Check if user exists in local database
        let user = await User.findOne({ where: { email } });

        if (user) {
            // If exists, directly save it with role SUPER_ADMIN
            await user.update({
                role: 'SUPER_ADMIN',
                permissions: null,
                allowedColleges: ['ALL']
            });

            const updatedUser = await User.findByPk(user.id, {
                attributes: { exclude: ['password'] }
            });

            return res.json({
                message: 'Existing user updated to SUPER_ADMIN',
                user: updatedUser
            });
        } else {
            // 2. If not exist, handle Keycloak
            let keycloakId = null;
            try {
                // Check if user exists in Keycloak
                const existingKcUser = await keycloakService.findUserByEmail(email);

                if (existingKcUser) {
                    keycloakId = existingKcUser.id;
                } else {
                    // Create in Keycloak
                    keycloakId = await keycloakService.createUser({
                        firstName,
                        lastName,
                        email,
                        password
                    });
                }

                // 3. Assign role SUPER_ADMIN in Keycloak
                const kcRole = await keycloakService.getOrCreateClientRole('SUPER_ADMIN');

                // Ensure the role exists in our local Role table too
                await Role.findOrCreate({
                    where: { roleName: 'SUPER_ADMIN' },
                    defaults: { roleId: kcRole.id, roleName: 'SUPER_ADMIN' }
                });

                await keycloakService.assignClientRole(keycloakId, 'SUPER_ADMIN');

            } catch (kcError) {
                console.error('Keycloak operation failed:', kcError);
                return res.status(500).json({ message: 'Error handling user in Keycloak', error: kcError.message });
            }

            // 4. Save in local database
            const hashedPassword = await bcrypt.hash(password, 10);
            const newUser = await User.create({
                firstName,
                lastName,
                email,
                mobileNo,
                password: hashedPassword,
                role: 'SUPER_ADMIN',
                keycloakId,
                permissions: null,
                allowedColleges: ['ALL']
            });

            const userResponse = await User.findByPk(newUser.id, {
                attributes: { exclude: ['password'] }
            });

            return res.status(201).json({
                message: 'Super Admin created and saved successfully',
                user: userResponse
            });
        }
    } catch (error) {
        console.error('Error in save-super-admin:', error);
        res.status(500).json({ message: 'Internal server error', error: error.message });
    }
});

// Get all roles
router.get('/roles', authMiddleware, async (req, res) => {
    try {
        const roles = await Role.findAll();
        res.json(roles);
    } catch (error) {
        console.error('Error fetching roles:', error);
        res.status(500).json({ message: 'Error fetching roles' });
    }
});

// Get current user profile
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id, {
            attributes: { exclude: ['password'] },
            include: [{ model: College, attributes: ['name'] }]
        });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(user);
    } catch (error) {
        console.error('Error fetching current user:', error);
        res.status(500).json({ message: 'Error fetching profile' });
    }
});

// Get all users (paginated)
router.get('/', authMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || '';
        const offset = (page - 1) * limit;

        const whereClause = {};
        if (search) {
            whereClause[Op.or] = [
                { firstName: { [Op.like]: `%${search}%` } },
                { lastName: { [Op.like]: `%${search}%` } },
                { email: { [Op.like]: `%${search}%` } },
                { mobileNo: { [Op.like]: `%${search}%` } }
            ];
        }

        // Apply restrictions for non-SUPER_ADMIN
        if (req.user.role !== 'SUPER_ADMIN' && !req.user.allowedColleges.includes('ALL')) {
            const allowed = req.user.allowedColleges || [];
            whereClause.collegeId = { [Op.in]: allowed };
        }

        const { count, rows } = await User.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            include: [{ model: College, attributes: ['name'] }],
            order: [['createdAt', 'DESC']],
            attributes: { exclude: ['password'] }
        });

        res.json({
            data: rows,
            total: count,
            page,
            totalPages: Math.ceil(count / limit)
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Error fetching users' });
    }
});

// Check if user must change password (called after login)
router.get('/check-password-status/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const user = await User.findOne({ where: { email } });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json({ mustChangePassword: user.mustChangePassword, isActive: user.isActive });
    } catch (error) {
        console.error('Error checking password status:', error);
        res.status(500).json({ message: 'Error checking password status' });
    }
});

// Change password (first login)
router.post('/change-password', async (req, res) => {
    try {
        const { email, newPassword } = req.body;

        if (!email || !newPassword) {
            return res.status(400).json({ message: 'Email and new password are required' });
        }

        const user = await User.findOne({ where: { email } });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (!user.keycloakId) {
            return res.status(400).json({ message: 'User has no Keycloak account' });
        }

        // Update password in Keycloak
        await keycloakService.resetPassword(user.keycloakId, newPassword);

        // Update hashed password in local DB and clear the flag
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await user.update({
            password: hashedPassword,
            mustChangePassword: false
        });

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ message: 'Error changing password' });
    }
});

// Generate Excel Template for Bulk Upload of Users
router.get('/template/download', authMiddleware, async (req, res) => {
    try {
        const workbook = new exceljs.Workbook();
        const sheet = workbook.addWorksheet('Users');

        // Add headers
        sheet.columns = [
            { header: 'First Name', key: 'firstName', width: 20 },
            { header: 'Last Name', key: 'lastName', width: 20 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Mobile No', key: 'mobileNo', width: 20 },
            { header: 'Role', key: 'role', width: 15 },
            { header: 'College Name', key: 'collegeName', width: 30 }
        ];

        // Add a sample row
        sheet.addRow({
            firstName: 'John',
            lastName: 'Doe',
            email: 'john.doe@example.com',
            mobileNo: '9876543210',
            role: 'STAFF',
            collegeName: ''
        });

        // Add a separate sheet for reference (Roles and Colleges)
        const refSheet = workbook.addWorksheet('Reference');
        refSheet.columns = [
            { header: 'Valid Roles', key: 'roles', width: 20 },
            { header: 'Active Colleges', key: 'colleges', width: 40 }
        ];

        const roles = await Role.findAll({ attributes: ['roleName'] });
        const roleNames = roles.map(r => r.roleName);
        const colleges = await College.findAll({ where: { isActive: true }, attributes: ['name'] });
        const collegeNames = ['All Colleges', ...colleges.map(c => c.name)];

        const maxRows = Math.max(roleNames.length, collegeNames.length);
        for (let i = 0; i < maxRows; i++) {
            refSheet.addRow({
                roles: roleNames[i] || '',
                colleges: collegeNames[i] || ''
            });
        }

        // Add data validation to the Users sheet
        // Column E (Role) and Column F (College Name)
        // We apply this to the first 500 rows to ensure they are available for new entries
        for (let i = 2; i <= 500; i++) {
            sheet.getCell(`E${i}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`Reference!$A$2:$A$${roleNames.length + 1}`],
                showErrorMessage: true,
                errorStyle: 'stop',
                errorTitle: 'Invalid Role',
                error: 'Please select a valid role from the list.'
            };

            sheet.getCell(`F${i}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`Reference!$B$2:$B$${collegeNames.length + 1}`],
                showErrorMessage: true,
                errorStyle: 'stop',
                errorTitle: 'Invalid College',
                error: 'Please select a valid college name from the list.'
            };
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=User_Bulk_Upload_Template.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error generating user template:', error);
        res.status(500).json({ message: 'Error generating template' });
    }
});

// Bulk Upload Users from Excel
router.post('/bulk-upload', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const workbook = new exceljs.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const sheet = workbook.getWorksheet('Users') || workbook.worksheets[0];

        if (!sheet) {
            return res.status(400).json({ message: 'Invalid Excel file structure' });
        }

        const defaultPassword = process.env.DEFAULT_USER_PASSWORD || 'Welcome@123';
        const rolesWithoutCollege = (process.env.ROLES_WITHOUT_COLLEGE || 'SUPER_ADMIN,STAFF')
            .split(',')
            .map(r => r.trim().toUpperCase());

        const usersToCreate = [];
        const errors = [];
        const emailSet = new Set();
        const mobileSet = new Set();

        // Fetch all colleges for name-to-id mapping
        const allColleges = await College.findAll({ attributes: ['id', 'name'] });
        const collegeMap = new Map(allColleges.map(c => [c.name.toLowerCase().trim(), c.id]));

        const rows = [];
        sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header
            rows.push({ row, rowNumber });
        });

        for (const { row, rowNumber } of rows) {
            const firstName = row.getCell(1).value?.toString().trim();
            const lastName = row.getCell(2).value?.toString().trim();
            const email = row.getCell(3).value?.toString().trim();
            const mobileNo = row.getCell(4).value?.toString().trim();
            const role = row.getCell(5).value?.toString().trim().toUpperCase();
            const collegeName = row.getCell(6).value?.toString().trim();

            if (!firstName && !lastName && !email) continue;

            if (!firstName || !lastName || !email || !mobileNo || !role) {
                errors.push(`Row ${rowNumber}: Missing required fields`);
                continue;
            }

            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                errors.push(`Row ${rowNumber}: Invalid email format`);
                continue;
            }

            if (emailSet.has(email)) {
                errors.push(`Row ${rowNumber}: Duplicate email in file (${email})`);
                continue;
            }
            if (mobileSet.has(mobileNo)) {
                errors.push(`Row ${rowNumber}: Duplicate mobile number in file (${mobileNo})`);
                continue;
            }

            // Check if user exists locally
            const localUser = await User.findOne({
                where: {
                    [Op.or]: [{ email }, { mobileNo }]
                }
            });
            if (localUser) {
                errors.push(`Row ${rowNumber}: User already exists in database (email or mobile)`);
                continue;
            }

            let collegeId = null;
            let allowedColleges = [];

            if (!rolesWithoutCollege.includes(role)) {
                if (!collegeName) {
                    errors.push(`Row ${rowNumber}: College Name is required for role ${role}`);
                    continue;
                }

                if (collegeName.toLowerCase() === 'all colleges') {
                    allowedColleges = ['ALL'];
                } else {
                    collegeId = collegeMap.get(collegeName.toLowerCase());
                    if (!collegeId) {
                        errors.push(`Row ${rowNumber}: College '${collegeName}' not found or inactive`);
                        continue;
                    }
                    allowedColleges = [collegeId];
                }
            }

            usersToCreate.push({ firstName, lastName, email, mobileNo, role, collegeId, allowedColleges, rowNumber });
            emailSet.add(email);
            mobileSet.add(mobileNo);
        }

        if (errors.length > 0) {
            return res.status(400).json({ message: 'Validation failed', errors });
        }

        const results = { success: 0, failed: 0, details: [] };

        for (const userData of usersToCreate) {
            try {
                const hashedPassword = await bcrypt.hash(defaultPassword, 10);
                const kcAttributes = {};
                if (userData.collegeId) {
                    kcAttributes.collegeId = [userData.collegeId];
                }

                let keycloakId = null;
                const existingKcUser = await keycloakService.findUserByEmail(userData.email);

                if (existingKcUser) {
                    keycloakId = existingKcUser.id;
                    // Update attributes
                    if (Object.keys(kcAttributes).length > 0) {
                        try {
                            await keycloakService.updateUserAttributes(keycloakId, kcAttributes);
                        } catch (e) {
                            console.warn(`KC Attribute Update Failed for ${userData.email}:`, e.message);
                        }
                    }
                } else {
                    // Create in Keycloak
                    keycloakId = await keycloakService.createUser({
                        firstName: userData.firstName,
                        lastName: userData.lastName,
                        email: userData.email,
                        password: defaultPassword
                    }, kcAttributes);
                }

                // Get or Create Role in Keycloak and DB
                const kcRole = await keycloakService.getOrCreateClientRole(userData.role);
                await Role.findOrCreate({
                    where: { roleName: userData.role },
                    defaults: { roleId: kcRole.id, roleName: userData.role }
                });

                // Assign Role
                if (keycloakId) {
                    try {
                        await keycloakService.assignClientRole(keycloakId, userData.role);
                    } catch (e) {
                        console.warn(`KC Role Assignment Failed for ${userData.email}:`, e.message);
                    }
                }

                // Save locally
                const defaultPermissions = {
                    menus: ['dashboard'],
                    actions: []
                };

                await User.create({
                    firstName: userData.firstName,
                    lastName: userData.lastName,
                    email: userData.email,
                    mobileNo: userData.mobileNo,
                    role: userData.role,
                    collegeId: userData.collegeId,
                    password: hashedPassword,
                    keycloakId: keycloakId,
                    permissions: userData.role === 'SUPER_ADMIN' ? null : defaultPermissions,
                    allowedColleges: userData.allowedColleges || []
                });

                results.success++;
            } catch (err) {
                console.error(`Failed to process user ${userData.email}:`, err);
                results.failed++;
                results.details.push(`Row ${userData.rowNumber} (${userData.email}): ${err.message}`);
            }
        }

        res.status(201).json({
            message: `Bulk upload completed. Success: ${results.success}, Failed: ${results.failed}`,
            results
        });

    } catch (error) {
        console.error('Error during user bulk upload:', error);
        res.status(500).json({ message: 'Error processing Excel file' });
    }
});

// Create a new user
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { firstName, lastName, email, mobileNo, role, collegeId } = req.body;

        // Use default password from environment
        const defaultPassword = process.env.DEFAULT_USER_PASSWORD || 'Welcome@123';

        // Roles that should NOT have collegeId (from env, comma-separated)
        const rolesWithoutCollege = (process.env.ROLES_WITHOUT_COLLEGE || 'SUPER_ADMIN,STAFF')
            .split(',')
            .map(r => r.trim().toUpperCase());

        const shouldAddCollegeId = !rolesWithoutCollege.includes(role?.toUpperCase()) && collegeId;

        // Check if email already exists in local DB
        const existingEmail = await User.findOne({ where: { email } });
        if (existingEmail) {
            return res.status(400).json({ message: 'Email already in use' });
        }

        // Check if mobile number already exists in local DB
        const existingMobile = await User.findOne({ where: { mobileNo } });
        if (existingMobile) {
            return res.status(400).json({ message: 'Mobile number already in use' });
        }

        const hashedPassword = await bcrypt.hash(defaultPassword, 10);

        // Build Keycloak attributes
        const kcAttributes = {};
        if (shouldAddCollegeId) {
            kcAttributes.collegeId = [collegeId];
        }

        // Check if user already exists in Keycloak
        let keycloakId = null;
        try {
            const existingKcUser = await keycloakService.findUserByEmail(email);
            if (existingKcUser) {
                // User already exists in Keycloak, use their ID
                keycloakId = existingKcUser.id;
                console.log(`User ${email} already exists in Keycloak with ID: ${keycloakId}`);

                // Update attributes on existing Keycloak user
                if (Object.keys(kcAttributes).length > 0) {
                    try {
                        await keycloakService.updateUserAttributes(keycloakId, kcAttributes);
                    } catch (attrError) {
                        console.warn('Failed to update Keycloak user attributes:', attrError.message);
                    }
                }
            } else {
                // User doesn't exist in Keycloak, create with temporary password and attributes
                keycloakId = await keycloakService.createUser({
                    firstName,
                    lastName,
                    email,
                    password: defaultPassword
                }, kcAttributes);
                console.log(`User ${email} created in Keycloak with ID: ${keycloakId}`);
            }

            // Get or Create Role in Keycloak and DB
            const kcRole = await keycloakService.getOrCreateClientRole(role);
            await Role.findOrCreate({
                where: { roleName: role },
                defaults: { roleId: kcRole.id, roleName: role }
            });

            // Assign client role in Keycloak
            if (keycloakId && role) {
                try {
                    await keycloakService.assignClientRole(keycloakId, role);
                } catch (roleError) {
                    console.warn(`Failed to assign role ${role} in Keycloak, continuing:`, roleError.message);
                }
            }
        } catch (kcError) {
            console.error('Failed to handle user in Keycloak:', kcError);
            return res.status(500).json({ message: 'Error handling user in Keycloak' });
        }

        const defaultPermissions = {
            menus: ['dashboard'],
            actions: []
        };

        const newUser = await User.create({
            firstName,
            lastName,
            email,
            mobileNo,
            password: hashedPassword,
            role,
            collegeId: collegeId === 'ALL' ? null : collegeId,
            keycloakId,
            permissions: role === 'SUPER_ADMIN' ? null : defaultPermissions,
            allowedColleges: collegeId === 'ALL' ? ['ALL'] : (collegeId ? [collegeId] : [])
        });

        const userResponse = await User.findByPk(newUser.id, {
            attributes: { exclude: ['password'] },
            include: [{ model: College, attributes: ['name'] }]
        });

        res.status(201).json(userResponse);
    } catch (error) {
        console.error('Error creating user:', error);
        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({ message: error.errors[0].message });
        }
        res.status(500).json({ message: 'Error creating user' });
    }
});

// Update a user
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { firstName, lastName, email, mobileNo, role, collegeId, password } = req.body;

        const user = await User.findByPk(id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const actualCollegeId = collegeId === 'ALL' ? null : collegeId;
        const allowedColleges = collegeId === 'ALL' ? ['ALL'] : (collegeId ? [collegeId] : []);

        const updateData = {
            firstName,
            lastName,
            email,
            mobileNo,
            role,
            collegeId: actualCollegeId,
            allowedColleges: allowedColleges
        };

        if (password) {
            updateData.password = await bcrypt.hash(password, 10);
        }

        await user.update(updateData);

        const updatedUser = await User.findByPk(id, {
            attributes: { exclude: ['password'] },
            include: [{ model: College, attributes: ['name'] }]
        });

        res.json(updatedUser);
    } catch (error) {
        console.error('Error updating user:', error);
        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({ message: error.errors[0].message });
        }
        res.status(500).json({ message: 'Error updating user' });
    }
});

// Delete a user
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const user = await User.findByPk(id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Delete from Keycloak if keycloakId exists
        if (user.keycloakId) {
            try {
                await keycloakService.deleteUser(user.keycloakId);
            } catch (kcError) {
                console.error('Failed to delete user from Keycloak:', kcError);
                // Continue with local deletion even if Keycloak fails
            }
        }

        await user.destroy();
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ message: 'Error deleting user' });
    }
});

// Reset user password to default
router.post('/:id/reset-password', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const user = await User.findByPk(id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const defaultPassword = process.env.DEFAULT_USER_PASSWORD || 'Welcome@123';
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);

        // Update in Keycloak if keycloakId exists
        if (user.keycloakId) {
            try {
                await keycloakService.resetPassword(user.keycloakId, defaultPassword);
            } catch (kcError) {
                console.error('Failed to reset password in Keycloak:', kcError);
                return res.status(500).json({ message: 'Error resetting password in Keycloak' });
            }
        }

        // Update locally and set mustChangePassword to true
        await user.update({
            password: hashedPassword,
            mustChangePassword: true
        });

        res.json({ message: 'Password reset successfully to default' });
    } catch (error) {
        console.error('Error resetting user password:', error);
        res.status(500).json({ message: 'Error resetting user password' });
    }
});

// Toggle user active/inactive status
router.patch('/:id/toggle-status', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const user = await User.findByPk(id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        await user.update({ isActive: !user.isActive });

        const updatedUser = await User.findByPk(id, {
            attributes: { exclude: ['password'] },
            include: [{ model: College, attributes: ['name'] }]
        });

        res.json(updatedUser);
    } catch (error) {
        console.error('Error toggling user status:', error);
        res.status(500).json({ message: 'Error toggling user status' });
    }
});

// Bulk update user status (activate/deactivate)
router.post('/bulk-status', authMiddleware, async (req, res) => {
    try {
        const { ids, isActive } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'Please provide an array of user IDs' });
        }

        if (typeof isActive !== 'boolean') {
            return res.status(400).json({ message: 'isActive must be a boolean value' });
        }

        await User.update({ isActive }, { where: { id: { [Op.in]: ids } } });

        res.json({ message: `${ids.length} user(s) ${isActive ? 'activated' : 'deactivated'} successfully` });
    } catch (error) {
        console.error('Error bulk updating user status:', error);
        res.status(500).json({ message: 'Error updating user statuses' });
    }
});

// Bulk delete users
router.post('/bulk-delete', authMiddleware, async (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'Please provide an array of user IDs' });
        }

        // Find all users to get keycloakIds for cleanup
        const users = await User.findAll({ where: { id: { [Op.in]: ids } } });

        // Delete from Keycloak
        for (const user of users) {
            if (user.keycloakId) {
                try {
                    await keycloakService.deleteUser(user.keycloakId);
                } catch (kcError) {
                    console.error(`Failed to delete user ${user.email} from Keycloak:`, kcError);
                }
            }
        }

        // Delete from local DB
        await User.destroy({ where: { id: { [Op.in]: ids } } });

        res.json({ message: `${users.length} user(s) deleted successfully` });
    } catch (error) {
        console.error('Error bulk deleting users:', error);
        res.status(500).json({ message: 'Error deleting users' });
    }
});

// Bulk update user permissions and allowed colleges
router.post('/bulk-permissions', authMiddleware, async (req, res) => {
    try {
        const { userIds, permissions, allowedColleges } = req.body;

        if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({ message: 'Please provide an array of user IDs' });
        }

        await User.update(
            { permissions, allowedColleges },
            { where: { id: { [Op.in]: userIds } } }
        );

        res.json({ message: `Access updated for ${userIds.length} user(s) successfully` });
    } catch (error) {
        console.error('Error bulk updating permissions:', error);
        res.status(500).json({ message: 'Error updating permissions' });
    }
});

module.exports = router;
