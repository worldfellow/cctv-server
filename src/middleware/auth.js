const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { User, College } = require('../models');

const jwksClient = jwksRsa({
    jwksUri: `${process.env.KC_HOSTNAME || 'http://localhost:8083'}/realms/${process.env.KEYCLOAK_REALM || 'erpai-realm'}/protocol/openid-connect/certs`
});

function getKey(header, callback) {
    jwksClient.getSigningKey(header.kid, function (err, key) {
        if (err) {
            callback(err);
        } else {
            const signingKey = key.getPublicKey();
            callback(null, signingKey);
        }
    });
}

module.exports = async (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader) {
        return res.status(401).json({ message: 'No token, authorization denied' });
    }

    const token = authHeader.replace('Bearer ', '');

    try {
        // First try to verify as Keycloak token
        jwt.verify(token, getKey, {
            algorithms: ['RS256']
        }, async (err, decoded) => {
            if (err) {
                // If Keycloak fails, try legacy JWT
                try {
                    const legacyDecoded = jwt.verify(token, process.env.JWT_SECRET || 'cctv_secret');
                    req.user = legacyDecoded;
                    return next();
                } catch (legacyErr) {
                    return res.status(401).json({ message: 'Token is not valid' });
                }
            }

            // Keycloak token is valid
            // Find or create user in our DB based on Keycloak ID (sub)
            let user = await User.findOne({ where: { keycloakId: decoded.sub } });

            if (!user) {
                // Check by email if user existed before Keycloak
                user = await User.findOne({ where: { email: decoded.email } });
                if (user) {
                    // Update existing user with Keycloak ID
                    user.keycloakId = decoded.sub;
                    await user.save();
                } else {
                    // Create minimal user record if it doesn't exist (Auto-provisioning)
                    user = await User.create({
                        keycloakId: decoded.sub,
                        email: decoded.email,
                        firstName: decoded.given_name || 'Keycloak',
                        lastName: decoded.family_name || 'User',
                        mobileNo: '0000000000', // Placeholder
                        role: 'VIEWER', // Default role
                    });
                }
            }

            req.user = {
                id: user.id,
                email: user.email,
                role: user.role,
                keycloakId: user.keycloakId,
                allowedColleges: user.allowedColleges || []
            };
            next();
        });
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.status(500).json({ message: 'Server error during authentication' });
    }
};
