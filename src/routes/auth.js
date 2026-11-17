const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { User, College } = require('../models');
const router = express.Router();

// The refresh token lives only in an HttpOnly cookie: JavaScript in the browser (and so XSS) can never read it.
const REFRESH_COOKIE = 'cctv_rt';
const COOKIE_PATH = '/api/auth';

const readCookie = (req, name) => {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0 && part.slice(0, idx).trim() === name) {
            try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
        }
    }
    return null;
};

const cookieOptions = (req, maxAgeMs) => ({
    httpOnly: true,
    // Browsers drop Secure cookies on plain http, so only require it when the request came over https
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : req.secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
    ...(maxAgeMs > 0 ? { maxAge: maxAgeMs } : {})
});

const setRefreshCookie = (req, res, data) => {
    if (!data.refresh_token) return;
    res.cookie(REFRESH_COOKIE, data.refresh_token, cookieOptions(req, (data.refresh_expires_in || 0) * 1000));
};

const clearRefreshCookie = (req, res) => {
    res.clearCookie(REFRESH_COOKIE, cookieOptions(req, 0));
};

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

    // KEYCLOAK_CLIENT_ID (cctv-server) is a confidential client: Keycloak rejects
    // the login unless its client secret is sent along.
    if (!process.env.KEYCLOAK_CLIENT_SECRET) {
        console.error('Keycloak login: KEYCLOAK_CLIENT_SECRET is not set in .env');
        return res.status(500).json({ error: 'server_misconfigured', message: 'Login is not configured on the server' });
    }

    const body = new URLSearchParams({
        grant_type: 'password',
        client_id: process.env.KEYCLOAK_CLIENT_ID,
        client_secret: process.env.KEYCLOAK_CLIENT_SECRET,
        username: email,
        password,
        scope: 'openid'
    });

    try {
        const { data } = await axios.post(tokenUrl, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        setRefreshCookie(req, res, data);
        return res.json({
            access_token: data.access_token,
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

// Keycloak OpenID Connect endpoint for this realm (token, logout, ...)
const keycloakOidcUrl = (endpoint) =>
    `${process.env.KC_HOSTNAME}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/${endpoint}`;

// Refresh: swap a refresh token for a new access token (+ rotated refresh token).
// Same proxy pattern as login, so the client secret never reaches the browser.
router.post('/refresh', async (req, res) => {
    const refreshToken = readCookie(req, REFRESH_COOKIE);
    if (!refreshToken) {
        return res.status(401).json({ error: 'invalid_grant', error_description: 'No session' });
    }
    if (!process.env.KEYCLOAK_CLIENT_SECRET) {
        console.error('Keycloak refresh: KEYCLOAK_CLIENT_SECRET is not set in .env');
        return res.status(500).json({ error: 'server_misconfigured', message: 'Login is not configured on the server' });
    }

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.KEYCLOAK_CLIENT_ID,
        client_secret: process.env.KEYCLOAK_CLIENT_SECRET,
        refresh_token: refreshToken
    });

    try {
        const { data } = await axios.post(keycloakOidcUrl('token'), body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        setRefreshCookie(req, res, data);
        return res.json({
            access_token: data.access_token,
            id_token: data.id_token,
            expires_in: data.expires_in,
            refresh_expires_in: data.refresh_expires_in
        });
    } catch (error) {
        if (error.response) {
            // invalid_grant = refresh token expired / session ended / user disabled: the user must log in again
            const { data } = error.response;
            clearRefreshCookie(req, res);
            return res.status(401).json({
                error: data?.error || 'invalid_grant',
                error_description: data?.error_description || 'Session expired'
            });
        }
        console.error('Keycloak refresh error:', error.message);
        return res.status(502).json({ error: 'keycloak_unreachable', message: 'Authentication server unreachable' });
    }
});

// Logout: end the Keycloak session so the refresh token can no longer be used
router.post('/logout', async (req, res) => {
    const refreshToken = readCookie(req, REFRESH_COOKIE);
    clearRefreshCookie(req, res);
    if (!refreshToken || !process.env.KEYCLOAK_CLIENT_SECRET) return res.status(204).end();

    const body = new URLSearchParams({
        client_id: process.env.KEYCLOAK_CLIENT_ID,
        client_secret: process.env.KEYCLOAK_CLIENT_SECRET,
        refresh_token: refreshToken
    });
    try {
        await axios.post(keycloakOidcUrl('logout'), body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
    } catch (error) {
        // Session already gone or Keycloak unreachable: the client clears its tokens either way
        console.warn('Keycloak logout failed:', error.response?.data?.error || error.message);
    }
    return res.status(204).end();
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
