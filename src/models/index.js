const sequelize = require('../config/database');
const User = require('./User');
const College = require('./College');
const Camera = require('./Camera');

const initDb = async () => {
    try {
        await sequelize.authenticate();
        console.log('Database connection has been established successfully.');

        // One-time migration: add isActive column if it doesn't exist
        try {
            const [results] = await sequelize.query(
                "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Users' AND COLUMN_NAME = 'isActive'"
            );
            if (results.length === 0) {
                await sequelize.query("ALTER TABLE `Users` ADD COLUMN `isActive` TINYINT(1) DEFAULT 1");
                console.log('Migration: Added isActive column to Users table.');
            }
        } catch (migrationError) {
            // Table might not exist yet (first run), sync will create it
            console.log('Migration check skipped for Users (table may not exist yet).');
        }

        // One-time migration: add isActive column to Colleges if it doesn't exist
        try {
            const [cols] = await sequelize.query("PRAGMA table_info('Colleges')");
            const hasIsActive = cols.some(col => col.name === 'isActive');
            if (!hasIsActive) {
                await sequelize.query("ALTER TABLE `Colleges` ADD COLUMN `isActive` TINYINT(1) DEFAULT 1");
                console.log('Migration: Added isActive column to Colleges table.');
            }
        } catch (migrationError) {
            console.log('Migration check skipped for Colleges (table may not exist yet).');
        }

        // Sync models (creates tables if they don't exist)
        await sequelize.sync();
        console.log('Database synchronized.');
    } catch (error) {
        console.error('Unable to connect to the database:', error);
    }
};

module.exports = {
    sequelize,
    User,
    College,
    Camera,
    initDb
};
