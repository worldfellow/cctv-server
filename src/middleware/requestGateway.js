const crypto = require('crypto');

// Hides API endpoint names. The client sends every request as `POST /api/gw` with an encrypted
// envelope { m: method, u: "/api/path?query", b: body, t: timestamp }. This middleware decrypts it
// and rewrites req.method / req.url / req.body so the normal routes handle it unchanged.
// Direct calls to the real endpoint paths (e.g. from Postman) are rejected.
// Counterpart: cctv-client/src/app/interceptors/gateway.interceptor.ts (same secret as response encryption).
const SECRET = process.env.RESPONSE_ENCRYPTION_KEY || 'cctv-dev-response-key-change-me';
const ENABLED = String(process.env.REQUEST_GATEWAY || 'true').toLowerCase() !== 'false';
const MAX_SKEW_MS = 5 * 60 * 1000;

const encKey = crypto.createHash('sha256').update('req-enc:' + SECRET).digest();
const macKey = crypto.createHash('sha256').update('req-mac:' + SECRET).digest();

const open = (b64) => {
    const raw = Buffer.from(String(b64), 'base64');
    if (raw.length < 16 + 16 + 32) throw new Error('short');
    const iv = raw.subarray(0, 16);
    const mac = raw.subarray(raw.length - 32);
    const body = raw.subarray(16, raw.length - 32);
    const expected = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, body])).digest();
    if (!crypto.timingSafeEqual(mac, expected)) throw new Error('bad mac');
    const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
};

// Paths the browser still reaches directly (not through the gateway)
const isExempt = (req) =>
    /^\/api\/(uploads|stream)(\/|$)/.test(req.path) || // static files and the video WebSocket
    req.method === 'OPTIONS';

const requestGateway = (req, res, next) => {
    if (!ENABLED) return next();

    if (req.method === 'POST' && req.path === '/api/gw') {
        try {
            const { m, u, b, t, f } = open(req.body && req.body.encrypted);
            if (!/^\/api\//.test(u) || /^\/api\/gw/.test(u)) throw new Error('bad path');
            if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw new Error('bad method');
            if (Math.abs(Date.now() - Number(t)) > MAX_SKEW_MS) throw new Error('stale');
            req.method = m;
            req.url = u;
            req.originalUrl = u;
            req.query = Object.fromEntries(new URL(u, 'http://gw').searchParams); // express parsed the query before the rewrite
            req.body = b === undefined || b === null ? {} : b;
            // Uploaded files arrive base64-encoded inside the envelope; present them the way multer would
            if (Array.isArray(f) && f.length) {
                req.files = f.map(file => {
                    const buffer = Buffer.from(String(file.data || ''), 'base64');
                    return { fieldname: file.field, originalname: String(file.name || 'file'), mimetype: file.type || 'application/octet-stream', size: buffer.length, buffer };
                });
                req.file = req.files[0];
            }
            req.viaGateway = true;
            return next();
        } catch {
            return res.status(400).json({ message: 'Invalid request' });
        }
    }

    if (req.path.startsWith('/api') && !isExempt(req)) {
        return res.status(404).json({ message: 'Not found' });
    }
    next();
};

module.exports = requestGateway;
