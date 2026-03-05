const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SystemConfig = sequelize.define('SystemConfig', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    appName: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'CCTV Surveillance'
    },
    logoUrl: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: '/assets/logo.png'
    },
    footerText: {
        type: DataTypes.STRING,
        allowNull: true
    }
});

module.exports = SystemConfig;
