const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { User, College } = require('../models');
const router = express.Router();

// Keycloak login proxy: the browser never talks to Keycloak's token endpoint.
// The server performs the grant with the confidential client's secret.
router.post('/keycloak-login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'invalid_request', message: 'Email and password are required' });
    }

    const baseUrl = process.env.KC_HOSTNAME;
    const realm = process.env.KEYCLOAK_REALM;
    const tokenUrl = `${baseUrl}/realms/${realm}/protocol/openid-connect/token`;

    // Use the PUBLIC client (Direct Access Grants enabled) for user password logins.
    // This is separate from KEYCLOAK_CLIENT_ID which is the confidential service-account client.
    const publicClientId = process.env.KEYCLOAK_PUBLIC_CLIENT_ID || process.env.KEYCLOAK_CLIENT_ID;

    const body = new URLSearchParams({
        grant_type: 'password',
        client_id: publicClientId,
        username: email,
        password,
        scope: 'openid'
    });

    try {
        const { data } = await axios.post(tokenUrl, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        return res.json({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            id_token: data.id_token,
            expires_in: data.expires_in
        });
    } catch (error) {
        if (error.response) {
            const { status, data } = error.response;
            return res.status(status).json({
                error: data?.error,
                error_description: data?.error_description
            });
        }
        console.error('Keycloak login error:', error.message);
        return res.status(502).json({ error: 'keycloak_unreachable', message: 'Authentication server unreachable' });
    }
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Check if user exists
        let user = await User.findOne({
            where: { email },
            include: [College]
        });

        // For demo purposes: if no users exist at all, create an admin user
        const userCount = await User.count();
        if (userCount === 0 && email === 'admin@example.com' && password === 'admin123') {
            const demoCollege = await College.create({ name: 'Default College' });
            const hashedPassword = await bcrypt.hash('admin123', 10);
            user = await User.create({
                firstName: 'System',
                lastName: 'Administrator',
                email: 'admin@example.com',
                password: hashedPassword,
                mobileNo: '1234567890',
                role: 'ADMIN',
                collegeId: demoCollege.id
            });
            user = await User.findOne({ where: { id: user.id }, include: [College] });
        }

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Verify password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET || 'cctv_secret',
            { expiresIn: '24h' }
        );

        return res.json({
            token,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                fullName: user.fullName,
                email: user.email,
                mobileNo: user.mobileNo,
                role: user.role,
                college: user.College ? user.College.name : null
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login' });
    }
});

module.exports = router;
