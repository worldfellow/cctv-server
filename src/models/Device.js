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
    }
}, {
    tableName: 'Devices',
    timestamps: true
});

module.exports = Device;
