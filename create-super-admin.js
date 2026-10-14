const keycloakService = require('./src/services/keycloak.service');
const { User, Role } = require('./src/models');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config();

async function run() {
    const userData = {
        firstName: 'Super',
        lastName: 'Admin',
        email: 'superadmin@example.com',
        mobileNo: '9999999999',
        password: 'Welcome@123'
    };

    console.log('Setting up Super Admin user:', userData.email);

    try {
        // Initialize keycloak service account
        await keycloakService.init();

        console.log('Checking user in Keycloak...');
        let keycloakId = null;
        const existingKcUser = await keycloakService.findUserByEmail(userData.email);

        if (existingKcUser) {
            keycloakId = existingKcUser.id;
            console.log('User already exists in Keycloak with ID:', keycloakId);
        } else {
            console.log('Creating user in Keycloak...');
            keycloakId = await keycloakService.createUser({
                firstName: userData.firstName,
                lastName: userData.lastName,
                email: userData.email,
                password: userData.password
            });
            console.log('User created in Keycloak with ID:', keycloakId);
        }

        console.log('Assigning SUPER_ADMIN role in Keycloak...');
        const kcRole = await keycloakService.getOrCreateClientRole('SUPER_ADMIN');
        await Role.findOrCreate({
            where: { roleName: 'SUPER_ADMIN' },
            defaults: { roleId: kcRole.id, roleName: 'SUPER_ADMIN' }
        });
        await keycloakService.assignClientRole(keycloakId, 'SUPER_ADMIN');
        console.log('Role assigned in Keycloak.');

        console.log('Updating database...');
        let user = await User.findOne({ where: { email: userData.email } });
        const hashedPassword = await bcrypt.hash(userData.password, 10);

        if (user) {
            await user.update({
                firstName: userData.firstName,
                lastName: userData.lastName,
                mobileNo: userData.mobileNo,
                password: hashedPassword,
                role: 'SUPER_ADMIN',
                keycloakId,
                permissions: null,
                allowedColleges: ['ALL']
            });
            console.log('SUCCESS: Existing local user upgraded and synced with Keycloak.');
        } else {
            await User.create({
                firstName: userData.firstName,
                lastName: userData.lastName,
                email: userData.email,
                mobileNo: userData.mobileNo,
                password: hashedPassword,
                role: 'SUPER_ADMIN',
                keycloakId,
                permissions: null,
                allowedColleges: ['ALL']
            });
            console.log('SUCCESS: New Super Admin created locally and in Keycloak.');
        }
        process.exit(0);
    } catch (error) {
        console.error('FAILED to set up Super Admin:', error);
        process.exit(1);
    }
}

run();
