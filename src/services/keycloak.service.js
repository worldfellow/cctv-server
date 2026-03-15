const dotenv = require('dotenv');

dotenv.config();

class KeycloakService {
    constructor() {
        this.kcAdminClient = null;
    }

    async init() {
        try {
            if (!this.kcAdminClient) {
                const { default: KcAdminClient } = await import('@keycloak/keycloak-admin-client');
                this.kcAdminClient = new KcAdminClient({
                    baseUrl: process.env.KC_HOSTNAME || 'http://localhost:8083',
                    realmName: 'master',
                });
            }
            await this.kcAdminClient.auth({
                username: process.env.KEYCLOAK_ADMIN || 'admin',
                password: process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin',
                grantType: 'password',
                clientId: 'admin-cli',
            });
            console.log('Keycloak Admin Client initialized');
        } catch (error) {
            console.error('Failed to initialize Keycloak Admin Client:', error);
            throw error;
        }
    }

    async createUser(userData, attributes = {}) {
        await this.init();
        const realm = process.env.KEYCLOAK_REALM || 'erpai-realm';

        try {
            const userPayload = {
                realm: realm,
                username: userData.email,
                email: userData.email,
                firstName: userData.firstName,
                lastName: userData.lastName,
                enabled: true,
                emailVerified: true,
                credentials: [{
                    type: 'password',
                    value: userData.password,
                    temporary: true
                }]
            };

            // Add custom attributes if provided
            if (Object.keys(attributes).length > 0) {
                userPayload.attributes = attributes;
            }

            const newUser = await this.kcAdminClient.users.create(userPayload);
            return newUser.id;
        } catch (error) {
            console.error('Error creating user in Keycloak:', error);
            throw error;
        }
    }

    async updateUserAttributes(keycloakUserId, attributes) {
        await this.init();
        const realm = process.env.KEYCLOAK_REALM || 'erpai-realm';

        try {
            await this.kcAdminClient.users.update(
                { realm: realm, id: keycloakUserId },
                { attributes: attributes }
            );
            console.log(`Attributes updated for user ${keycloakUserId}`);
        } catch (error) {
            console.error('Error updating user attributes in Keycloak:', error);
            throw error;
        }
    }

    async getOrCreateClientRole(roleName) {
        await this.init();
        const realm = process.env.KEYCLOAK_REALM || 'erpai-realm';
        const clientId = process.env.KEYCLOAK_CLIENT_ID || 'erpai2.0-client';

        try {
            const clients = await this.kcAdminClient.clients.find({
                realm: realm,
                clientId: clientId
            });

            if (!clients || clients.length === 0) {
                throw new Error(`Client ${clientId} not found in Keycloak`);
            }

            const client = clients[0];

            // Try to find the role directly first (more efficient and avoids pagination issues)
            try {
                const role = await this.kcAdminClient.clients.findRole({
                    realm: realm,
                    id: client.id,
                    roleName: roleName
                });
                if (role) return role;
            } catch (error) {
                // findRole might not be supported or might throw 404
                console.log(`Direct findRole for ${roleName} failed or not found, falling back to list...`);
            }

            // Fallback to listing roles
            const roles = await this.kcAdminClient.clients.listRoles({
                realm: realm,
                id: client.id,
                max: 1000 // Increase limit to avoid missing roles
            });

            let targetRole = roles.find(r => r.name === roleName);

            if (!targetRole) {
                console.log(`Role ${roleName} not found in client ${clientId}, creating it...`);
                try {
                    await this.kcAdminClient.clients.createRole({
                        realm: realm,
                        id: client.id,
                        name: roleName
                    });
                } catch (createError) {
                    // Check if role was created by another process or already exists
                    const errorMsg = createError.message || "";
                    const errorData = createError.response?.data?.errorMessage || "";

                    if (errorMsg.includes('already exists') || errorData.includes('already exists') || createError.status === 409) {
                        console.log(`Role ${roleName} already exists in Keycloak (confirmed by conflict error).`);
                    } else {
                        throw createError;
                    }
                }

                // Fetch roles again to get the new/existing role object
                const updatedRoles = await this.kcAdminClient.clients.listRoles({
                    realm: realm,
                    id: client.id,
                    max: 1000
                });
                targetRole = updatedRoles.find(r => r.name === roleName);
            }

            if (!targetRole) {
                throw new Error(`Failed to create or find role: ${roleName}`);
            }

            return targetRole;
        } catch (error) {
            console.error('Error in getOrCreateClientRole:', error);
            throw error;
        }
    }

    async assignClientRole(keycloakUserId, roleName) {
        await this.init();
        const realm = process.env.KEYCLOAK_REALM || 'erpai-realm';
        const clientId = process.env.KEYCLOAK_CLIENT_ID || 'erpai2.0-client';

        try {
            const clients = await this.kcAdminClient.clients.find({
                realm: realm,
                clientId: clientId
            });

            if (!clients || clients.length === 0) {
                console.error(`Client ${clientId} not found in Keycloak`);
                return;
            }

            const client = clients[0];
            const targetRole = await this.getOrCreateClientRole(roleName);

            if (!targetRole) {
                console.error(`Failed to create or find role ${roleName}`);
                return;
            }

            // Assign the role to the user
            await this.kcAdminClient.users.addClientRoleMappings({
                realm: realm,
                id: keycloakUserId,
                clientUniqueId: client.id,
                roles: [{ id: targetRole.id, name: targetRole.name }]
            });

            console.log(`Role ${roleName} assigned to user ${keycloakUserId}`);
        } catch (error) {
            console.error('Error assigning client role in Keycloak:', error);
            throw error;
        }
    }

    async findUserByEmail(email) {
        await this.init();
        const realm = process.env.KEYCLOAK_REALM || 'erpai-realm';
        const users = await this.kcAdminClient.users.find({
            realm: realm,
            email: email,
        });
        return users.length > 0 ? users[0] : null;
    }

    async resetPassword(keycloakUserId, newPassword) {
        await this.init();
        const realm = process.env.KEYCLOAK_REALM || 'erpai-realm';

        try {
            await this.kcAdminClient.users.resetPassword({
                realm: realm,
                id: keycloakUserId,
                credential: {
                    type: 'password',
                    value: newPassword,
                    temporary: false
                }
            });
            console.log(`Password reset for user ${keycloakUserId}`);
        } catch (error) {
            console.error('Error resetting password in Keycloak:', error);
            throw error;
        }
    }

    async deleteUser(keycloakId) {
        await this.init();
        const realm = process.env.KEYCLOAK_REALM || 'erpai-realm';
        await this.kcAdminClient.users.del({
            realm: realm,
            id: keycloakId,
        });
    }
}

module.exports = new KeycloakService();
