const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
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

dotenv.config();

// Initialize Database
initDb();

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

const path = require('path');

const { createProxyMiddleware } = require('http-proxy-middleware');

app.use(cors());

// Proxy Keycloak traffic directly to port 8083
// app.use(createProxyMiddleware({
//   target: 'http://localhost:8083',
//   changeOrigin: false,
//   pathFilter: ['/realms', '/resources', '/robots.txt', '/admin', '/js'],
//   logLevel: 'debug'
// }));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(morgan('dev'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/feeds', feedRoutes);
app.use('/api/users', userRoutes);
app.use('/api/colleges', collegeRoutes);
app.use('/api/cameras', cameraRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/screenshots', screenshotRoutes);
app.use('/api/config', configRoutes);

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../../dist/cctv-client')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../dist/cctv-client/index.html'));
});

// Serve static files from FILE_LOCATION at /uploads
if (process.env.FILE_LOCATION) {
  app.use('/uploads', express.static(process.env.FILE_LOCATION));
}

// Serve public assets (logo, etc.)
app.use('/assets', express.static(path.join(__dirname, '../public/assets')));

// SPA fallback for non-API routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(clientPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
