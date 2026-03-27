const cluster = require('cluster');
const os = require('os');
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
const streamManager = require('./services/streamManager');

dotenv.config();

if (cluster.isPrimary) {
  const numCPUs = os.cpus().length;
  const workersToLaunch = Math.min(numCPUs, 4); // Adaptive but capped for stability
  console.log(`[Primary] Master process ${process.pid} is running. Launching ${workersToLaunch} workers...`);

  // Initialize Database once in primary (optional, but good for migrations)
  initDb();

  // Initialize streamManager in Primary to handle FFmpeg orchestration
  streamManager.initPrimary();

  for (let i = 0; i < workersToLaunch; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`[Primary] Worker ${worker.process.pid} died. Forking a replacement...`);
    cluster.fork();
  });

} else {
  // Worker processes handle the Express server and WebSockets
  const app = express();
  app.set('trust proxy', true);
  const PORT = process.env.PORT || 3000;

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

  // Serve static files
  const uploadsPath = process.env.FILE_LOCATION;
  if (uploadsPath) {
    app.use('/api/uploads', express.static(uploadsPath));
  }

  const server = app.listen(PORT, () => {
    console.log(`[Worker ${process.pid}] Server is running on port ${PORT}`);
  });

  // Attach streamManager to the server in context-aware mode
  streamManager.attach(server);
}

