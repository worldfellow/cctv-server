const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Camera = require('./Camera');

// Latest connectivity state of each camera, written by the background health monitor
const CameraHealth = sequelize.define('CameraHealth', {
    cameraId: {
        type: DataTypes.UUID,
        primaryKey: true
    },
    collegeId: {
        type: DataTypes.UUID,
        allowNull: false
    },
    // Confirmed status: online | stream_error | no_response | offline
    status: {
        type: DataTypes.STRING(20),
        allowNull: false
    },
    // Result of the most recent check (may differ from status while a failure is unconfirmed)
    lastResult: {
        type: DataTypes.STRING(20),
        allowNull: false
    },
    rtspCode: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    latencyMs: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    error: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    consecutiveFailures: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    lastCheckedAt: {
        type: DataTypes.DATE,
        allowNull: false
    },
    lastOnlineAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    statusSince: {
        type: DataTypes.DATE,
        allowNull: false
    }
}, {
    tableName: 'CameraHealth',
    timestamps: false,
    indexes: [
        { fields: ['collegeId'] },
        { fields: ['lastCheckedAt'] }
    ]
});

Camera.hasOne(CameraHealth, { foreignKey: 'cameraId', onDelete: 'CASCADE', onUpdate: 'CASCADE' });
CameraHealth.belongsTo(Camera, { foreignKey: 'cameraId', onDelete: 'CASCADE', onUpdate: 'CASCADE' });

module.exports = CameraHealth;
