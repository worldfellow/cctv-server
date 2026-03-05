const keycloakService = require('./src/services/keycloak.service');
const dotenv = require('dotenv');

dotenv.config();

async function verifyRoleCreation() {
    console.log('Testing automatic role creation in Keycloak...');
    const testRoleName = 'TEST_ROLE_' + Date.now();
    const testEmail = 'test-user-' + Date.now() + '@example.com';
    let userId = null;

    try {
        await keycloakService.init();
        console.log('Keycloak Admin Client initialized.');

        console.log(`Step 1: Creating test user: ${testEmail}`);
        userId = await keycloakService.createUser({
            firstName: 'Test',
            lastName: 'User',
            email: testEmail,
            password: 'TestPassword123!'
        });
        console.log(`SUCCESS: Test user created with ID: ${userId}`);

        console.log(`Step 2: Assigning non-existent role: ${testRoleName}`);
        await keycloakService.assignClientRole(userId, testRoleName);
        console.log(`SUCCESS: assignClientRole call completed.`);

        // Verification: Check if role exists and user has it
        const realm = process.env.KEYCLOAK_REALM || 'erpai-realm';
        const clientId = process.env.KEYCLOAK_CLIENT_ID || 'erpai2.0-client';

        const clients = await keycloakService.kcAdminClient.clients.find({
            realm: realm,
            clientId: clientId
        });
        const client = clients[0];

        const roles = await keycloakService.kcAdminClient.clients.listRoles({
            realm: realm,
            id: client.id
        });
        const createdRole = roles.find(r => r.name === testRoleName);

        if (createdRole) {
            console.log(`SUCCESS: Role ${testRoleName} was automatically created.`);
        } else {
            throw new Error(`FAILURE: Role ${testRoleName} was NOT created.`);
        }

        const userRoles = await keycloakService.kcAdminClient.users.listClientRoleMappings({
            realm: realm,
            id: userId,
            clientUniqueId: client.id
        });

        if (userRoles.some(r => r.name === testRoleName)) {
            console.log(`SUCCESS: Role ${testRoleName} was assigned to user.`);
        } else {
            throw new Error(`FAILURE: Role ${testRoleName} was NOT assigned to user.`);
        }

        console.log('All verification steps passed!');

    } catch (error) {
        console.error('Verification failed:', error);
    } finally {
        if (userId) {
            console.log('Cleaning up: Deleting test user...');
            try {
                await keycloakService.deleteUser(userId);
                console.log('Test user deleted.');
            } catch (e) {
                console.warn('Failed to delete test user:', e.message);
            }
        }
        // Note: We don't delete the role to avoid complex logic if multiple users were assigned, 
        // but in a real test environment we might.
        process.exit(0);
    }
}

verifyRoleCreation();
