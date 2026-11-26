const express = require('express');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const requestGateway = require('./middleware/requestGateway');
const responseEncryption = require('./middleware/responseEncryption');
const dotenv = require('dotenv');
const { initDb } = require('./models');
const authRoutes = require('./routes/auth');
const feedRoutes = require('./routes/feeds');
const userRoutes = require('./routes/users');
const collegeRoutes = require('./routes/colleges');
const cameraRoutes = require('./routes/cameras');
const dashboardRoutes = require('./routes/dashboard');
const screenshotRoutes = require('./routes/screenshots');
const configRoutes = require('./routes/config');
const deviceRoutes = require('./routes/devices');
const connectivityRoutes = require('./routes/connectivity');
const streamManager = require('./services/streamManager');
const healthMonitor = require('./services/healthMonitor.service');

dotenv.config();

// Initialize Database
// Background camera connectivity checks start once the database is ready
initDb().then(() => healthMonitor.start());

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// credentials: true lets the browser send/accept the HttpOnly refresh cookie on cross-origin dev setups.
// Set CORS_ORIGINS (comma-separated) to restrict allowed origins; unset keeps the previous open behaviour.
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
// Security headers: HSTS (browsers only honour it over HTTPS), nosniff, frame denial, referrer policy, etc.
// The API only returns JSON/files, so the default restrictive CSP is fine; images (logo uploads) are
// loaded cross-origin by the client, hence cross-origin resource policy.
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: { maxAge: 15552000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' }
}));
app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // API responses carry personal data: never let browsers or proxies cache them
    if (req.path.startsWith('/api') && !req.path.startsWith('/api/uploads')) res.setHeader('Cache-Control', 'no-store');
    next();
});
app.use(cors({ origin: corsOrigins.length ? corsOrigins : true, credentials: true, exposedHeaders: ['Retry-After'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(morgan('dev'));

// Encrypted request envelope (hides endpoint names); REQUEST_GATEWAY=false disables it
app.use(requestGateway);

// Encrypt all JSON responses (client decrypts in its HTTP interceptor); set RESPONSE_ENCRYPTION=false to disable
app.use('/api', responseEncryption);

// Rate limiting (override with RATE_LIMIT_* env vars). Client IP comes from X-Forwarded-For
// because 'trust proxy' is on, so the library's trust-proxy sanity check is switched off.
const num = (v, d) => parseInt(v) > 0 ? parseInt(v) : d;
const limiterBase = { standardHeaders: true, legacyHeaders: false, validate: { trustProxy: false } };
// 429 body tells the client how many seconds to wait; the client shows a countdown page
const tooMany = (message) => (req, res) => {
    const resetAt = req.rateLimit && req.rateLimit.resetTime ? new Date(req.rateLimit.resetTime).getTime() : Date.now() + 60000;
    const retryAfter = Math.max(Math.ceil((resetAt - Date.now()) / 1000), 1);
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ message, retryAfter });
};
const apiLimiter = rateLimit({
    ...limiterBase,
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 5 * 60 * 1000), // API: 5 minutes
    limit: num(process.env.RATE_LIMIT_MAX, 3000), // generous: many users may share one college IP
    handler: tooMany('Too many requests, please try again later.')
});
const loginLimiter = rateLimit({
    ...limiterBase,
    windowMs: num(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: num(process.env.LOGIN_RATE_LIMIT_MAX, 20),
    skipSuccessfulRequests: true, // only failed logins count
    handler: tooMany('Too many login attempts, please try again later.')
});
app.use('/api', apiLimiter);
app.use(['/api/auth/login', '/api/auth/x7Kq2mVd9RtLw4Ze'], loginLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/feeds', feedRoutes);
app.use('/api/users', userRoutes);
app.use('/api/colleges', collegeRoutes);
app.use('/api/cameras', cameraRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/screenshots', screenshotRoutes);
app.use('/api/config', configRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/connectivity', connectivityRoutes);

// Serve static files (same fallback folder the logo upload in routes/config.js writes to)
const uploadsPath = process.env.FILE_LOCATION || path.join(__dirname, '../../uploads');
// Only the branding logo is public (the login page needs it). Screenshots and everything else under
// uploads/ are NOT served statically: they're delivered by the authenticated GET /api/screenshots/file/:id.
app.use('/api/uploads/config', express.static(path.join(uploadsPath, 'config'), { index: false, dotfiles: 'deny' }));

const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Attach streamManager to the server
streamManager.attach(server);
