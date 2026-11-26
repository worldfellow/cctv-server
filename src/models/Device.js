const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Device = sequelize.define('Device', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    deviceName: {
        type: DataTypes.STRING,
        allowNull: false
    },
    rtspLink: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    // FFmpeg -rtsp_transport value; see migrations/20261120-add-rtsp-transport-to-devices.js
    rtspTransport: {
        type: DataTypes.STRING(8),
        allowNull: false,
        defaultValue: 'tcp',
        validate: { isIn: [['tcp', 'udp']] }
    }
}, {
    tableName: 'Devices',
    timestamps: true
});

module.exports = Device;
