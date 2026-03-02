const keycloakService = require('./src/services/keycloak.service');
const dotenv = require('dotenv');

dotenv.config();

async function testKeycloak() {
    console.log('Testing Keycloak connection...');
    try {
        await keycloakService.init();
        console.log('SUCCESS: Keycloak Admin Client connected.');

        const email = 'test-admin-' + Date.now() + '@example.com';
        console.log(`Creating test user: ${email}`);

        const userId = await keycloakService.createUser({
            firstName: 'Test',
            lastName: 'Admin',
            email: email,
            password: 'TestPassword123!'
        });
        console.log(`SUCCESS: Test user created with ID: ${userId}`);

        console.log('Deleting test user...');
        await keycloakService.deleteUser(userId);
        console.log('SUCCESS: Test user deleted.');

        console.log('All Keycloak tests passed!');
        process.exit(0);
    } catch (error) {
        console.error('FAILURE: Keycloak test failed:', error);
        process.exit(1);
    }
}

testKeycloak();
