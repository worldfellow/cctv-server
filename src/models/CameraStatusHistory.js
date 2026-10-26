const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Camera = require('./Camera');

// One row per confirmed status change (fromStatus is null on a camera's first check)
const CameraStatusHistory = sequelize.define('CameraStatusHistory', {
    id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true
    },
    cameraId: {
        type: DataTypes.UUID,
        allowNull: false
    },
    collegeId: {
        type: DataTypes.UUID,
        allowNull: false
    },
    fromStatus: {
        type: DataTypes.STRING(20),
        allowNull: true
    },
    toStatus: {
        type: DataTypes.STRING(20),
        allowNull: false
    },
    rtspCode: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    error: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    changedAt: {
        type: DataTypes.DATE,
        allowNull: false
    }
}, {
    tableName: 'CameraStatusHistory',
    timestamps: false,
    indexes: [
        { fields: ['cameraId', 'changedAt'] },
        { fields: ['collegeId', 'changedAt'] },
        { fields: ['changedAt'] }
    ]
});

Camera.hasMany(CameraStatusHistory, { foreignKey: 'cameraId', onDelete: 'CASCADE', onUpdate: 'CASCADE' });
CameraStatusHistory.belongsTo(Camera, { foreignKey: 'cameraId', onDelete: 'CASCADE', onUpdate: 'CASCADE' });

module.exports = CameraStatusHistory;
