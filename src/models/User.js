const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const College = require('./College');

const User = sequelize.define('User', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    firstName: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    lastName: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    fullName: {
        type: DataTypes.VIRTUAL,
        get() {
            return `${this.firstName} ${this.lastName}`;
        },
        set(value) {
            throw new Error('Do not try to set the `fullName` value!');
        }
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: {
            isEmail: true
        }
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false
    },
    mobileNo: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: {
            is: /^[0-9]{10}$/
        }
    },
    collegeId: {
        type: DataTypes.UUID,
        allowNull: true
    },
    role: {
        type: DataTypes.STRING,
        allowNull: false
    },
    keycloakId: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true
    },
    mustChangePassword: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    permissions: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: {
            menus: ['dashboard'],
            actions: []
        },
        comment: '{ menus: string[], actions: string[] }'
    },
    allowedColleges: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
        comment: 'string[] (IDs) or ["ALL"]'
    }
});

// Associations
User.belongsTo(College, { foreignKey: 'collegeId' });
College.hasMany(User, { foreignKey: 'collegeId' });

module.exports = User;
