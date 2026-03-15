const sequelize = require('../config/database');
const User = require('./User');
const College = require('./College');
const Camera = require('./Camera');
const Role = require('./Role');
const Screenshot = require('./Screenshot');
const SystemConfig = require('./SystemConfig');

const initDb = async () => {
    try {
        await sequelize.authenticate();
        console.log('Database connection has been established successfully.');

        // One-time migration: add isActive column if it doesn't exist
        const queryInterface = sequelize.getQueryInterface();

        try {
            const userTable = await queryInterface.describeTable('Users');
            if (!userTable.isActive) {
                await sequelize.query("ALTER TABLE `Users` ADD COLUMN `isActive` TINYINT(1) DEFAULT 1");
                console.log('Migration: Added isActive column to Users table.');
            }
        } catch (migrationError) {
            // Table might not exist yet (first run), sync will create it
            console.log('Migration check skipped for Users (table may not exist yet).');
        }

        // One-time migration: add isActive column to Colleges if it doesn't exist
        try {
            const collegeTable = await queryInterface.describeTable('Colleges');
            if (!collegeTable.isActive) {
                await sequelize.query("ALTER TABLE `Colleges` ADD COLUMN `isActive` TINYINT(1) DEFAULT 1");
                console.log('Migration: Added isActive column to Colleges table.');
            }
        } catch (migrationError) {
            console.log('Migration check skipped for Colleges (table may not exist yet).');
        }

        // Sync models (creates tables if they don't exist, and updates schema)
        await sequelize.sync({ alter: true });
        console.log('Database synchronized.');

        // Seed initial roles
        // We'll require Keycloak here to avoid circular dependencies if any
        const keycloakService = require('../services/keycloak.service');
        const initialRoles = ['STAFF', 'SUPER_ADMIN'];
        for (const roleName of initialRoles) {
            try {
                const kcRole = await keycloakService.getOrCreateClientRole(roleName);
                await Role.findOrCreate({
                    where: { roleName },
                    defaults: { roleId: kcRole.id, roleName }
                });
            } catch (err) {
                console.warn(`Failed to seed role ${roleName}:`, err.message);
            }
        }

        // Seed default system config
        try {
            const configCount = await SystemConfig.count();
            if (configCount === 0) {
                await SystemConfig.create({
                    appName: 'CCTV Surveillance',
                    logoUrl: '/assets/logo.png'
                });
                console.log('Seeded default system configuration.');
            }
        } catch (err) {
            console.warn('Failed to seed system configuration:', err.message);
        }
    } catch (error) {
        console.error('Unable to connect to the database:', error);
    }
};

module.exports = {
    sequelize,
    User,
    College,
    Camera,
    Role,
    Screenshot,
    SystemConfig,
    initDb
};
