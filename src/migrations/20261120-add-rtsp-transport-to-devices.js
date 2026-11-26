/**
 * Migration: add `rtspTransport` to Devices.
 * Controls the FFmpeg `-rtsp_transport` option ('tcp' or 'udp'). Defaults to 'tcp'.
 *
 * Idempotent: safe to run on every startup (called from initDb in models/index.js).
 */
const TABLE = 'Devices';
const COLUMN = 'rtspTransport';

module.exports = {
    name: '20261120-add-rtsp-transport-to-devices',

    async up(sequelize) {
        const { DataTypes } = require('sequelize');
        const queryInterface = sequelize.getQueryInterface();

        const table = await queryInterface.describeTable(TABLE);
        if (table[COLUMN]) return false;

        await queryInterface.addColumn(TABLE, COLUMN, {
            type: DataTypes.STRING(8),
            allowNull: false,
            defaultValue: 'tcp'
        });
        return true;
    },

    async down(sequelize) {
        const queryInterface = sequelize.getQueryInterface();
        const table = await queryInterface.describeTable(TABLE);
        if (!table[COLUMN]) return false;

        await queryInterface.removeColumn(TABLE, COLUMN);
        return true;
    }
};
