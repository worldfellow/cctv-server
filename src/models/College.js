const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const College = sequelize.define('College', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    address: {
        type: DataTypes.STRING,
        allowNull: true
    },
    contactEmail: {
        type: DataTypes.STRING,
        allowNull: true,
        validate: {
            isEmail: true
        }
    },
    // Required (enforced in the routes; column stays nullable so existing rows can migrate)
    mobileNo: {
        type: DataTypes.STRING(10),
        allowNull: true,
        validate: {
            is: { args: /^\d{10}$/, msg: 'Mobile number must be exactly 10 digits' }
        }
    },
    cameraPersonnelName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
});

module.exports = College;
