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

app.use(express.json());
app.use(morgan('dev'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/feeds', feedRoutes);
app.use('/api/users', userRoutes);
app.use('/api/colleges', collegeRoutes);
app.use('/api/cameras', cameraRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Serve static frontend files
const clientPath = path.join(__dirname, '../../cctv-client/dist/cctv-client/browser');
app.use(express.static(clientPath));

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
