const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const College = require('./College');
const Device = require('./Device');

const Camera = sequelize.define('Camera', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    collegeId: {
        type: DataTypes.UUID,
        allowNull: false
    },
    deviceId: {
        type: DataTypes.UUID,
        allowNull: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    location: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    ipAddress: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
            isIPv4: true
        }
    },
    rtspPort: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 554
    },
    channel: {
        type: DataTypes.STRING,
        allowNull: false
    },
    username: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Stores the encrypted username for RTSP authentication'
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Stores the encrypted password for RTSP authentication'
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
}, {
    timestamps: true
});

// Associations
Camera.belongsTo(College, {
    foreignKey: 'collegeId',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
});
College.hasMany(Camera, {
    foreignKey: 'collegeId',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
});

Camera.belongsTo(Device, {
    foreignKey: 'deviceId',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE'
});

Device.hasMany(Camera, {
    foreignKey: 'deviceId',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE'
});

module.exports = Camera;
