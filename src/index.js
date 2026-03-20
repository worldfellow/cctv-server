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

const fs = require('fs');
const path = require('path');

const { createProxyMiddleware } = require('http-proxy-middleware');

app.use(cors());

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

// Serve static files from FILE_LOCATION at /uploads
const uploadsPath = process.env.FILE_LOCATION || path.join(__dirname, '../../uploads');
console.log(`Serving uploads from: ${uploadsPath}`);
app.use('/uploads', express.static(uploadsPath));

// Serve static frontend files
// const clientPath = path.join(__dirname, '../../cctv-client/dist/cctv-client/browser');
// if (fs.existsSync(clientPath)) {
//   console.log(`Serving frontend from: ${clientPath}`);
//   app.use(express.static(clientPath));

// SPA fallback for non-API routes
// app.get('*', (req, res, next) => {
//   if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
//     return next();
//   }
//   const indexPath = path.join(clientPath, 'index.html');
//   if (fs.existsSync(indexPath)) {
//     res.sendFile(indexPath);
//   } else {
//     res.status(404).send('Frontend not built');
//   }
// });
// } else {
//   console.warn(`Frontend build not found at: ${clientPath}`);
// }

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
