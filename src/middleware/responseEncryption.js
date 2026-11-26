const crypto = require('crypto');

// Encrypts every JSON body sent to the client (AES-256-CBC + HMAC-SHA256, encrypt-then-MAC).
// Wire format: { "encrypted": base64( iv[16] | ciphertext | hmac[32] ) }
// Client counterpart: cctv-client/src/app/utils/response-crypto.ts (must use the same secret).
// Binary responses (Excel, PDF, images, streams) don't go through res.json and are left untouched.
const SECRET = process.env.RESPONSE_ENCRYPTION_KEY || 'cctv-dev-response-key-change-me';
const ENABLED = String(process.env.RESPONSE_ENCRYPTION || 'true').toLowerCase() !== 'false';

const encKey = crypto.createHash('sha256').update(SECRET).digest();
const macKey = crypto.createHash('sha256').update('mac:' + SECRET).digest();

const encryptPayload = (payload) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(payload === undefined ? null : payload), 'utf8'), cipher.final()]);
    const mac = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, body])).digest();
    return Buffer.concat([iv, body, mac]).toString('base64');
};

const responseEncryption = (req, res, next) => {
    if (!ENABLED) return next();
    const originalJson = res.json.bind(res);
    res.json = (payload) => originalJson({ encrypted: encryptPayload(payload) });
    next();
};

module.exports = responseEncryption;
module.exports.encryptPayload = encryptPayload;
