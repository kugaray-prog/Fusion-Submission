require('dotenv').config();

// Event times are stored as Philippine local time without a zone, so pin the
// process timezone before any Date is created (hosts often default to UTC).
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Manila';

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { accountRateLimitOptions } = require('./middleware/rateLimitKey');

const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const config = require('./config/config');

// Log stray async errors instead of crashing the server.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

console.log(`Environment: ${NODE_ENV}`);

app.use(
  helmet({
    contentSecurityPolicy: false,
    // Lets the Google Sign-In popup message the login page.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
  })
);

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_session_secret',

    resave: false,

    saveUninitialized: false,

    cookie: {
      secure: NODE_ENV === 'production',
      httpOnly: true,
      sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

// Browser auto-refresh on file changes, development only.
if (NODE_ENV !== 'production') {
  require('./services/devLiveReload').mount(app);
}

// Global /api limiter, production only. Login has its own stricter limiter
// in authRoutes.js / employeeAuthRoutes.js.

const apiLimiter = rateLimit({
  // Keyed per account or real client IP (see middleware/rateLimitKey.js).
  ...accountRateLimitOptions,
  windowMs: 15 * 60 * 1000,

  max: 1000,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    message: 'Too many requests. Please try again later.'
  }
});

if (NODE_ENV === 'production') {
  app.use('/api', apiLimiter);

  console.log('API rate limiting: ENABLED');
} else {
  console.log('API rate limiting: DISABLED (development mode)');
}

app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'))
);

// Fallback: serve the database copy when the file is missing on disk.
app.use(
  '/uploads',
  require('./services/uploadStore').serveStoredUpload
);

app.use(
  '/public',
  express.static(path.join(__dirname, 'public'))
);

app.use(
  express.static(path.join(__dirname, 'public'))
);

// Request log, e.g. "[10:42:07] GET /api/nav/employees 200 3ms".
// Registered after the static handlers so asset hits stay quiet.

const METHOD_COLORS = {
  GET: '\x1b[32m',
  POST: '\x1b[33m',
  PUT: '\x1b[34m',
  PATCH: '\x1b[36m',
  DELETE: '\x1b[31m'
};

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const time = new Date().toLocaleTimeString('en-GB');
    const color = METHOD_COLORS[req.method] || '\x1b[37m';
    const statusColor = res.statusCode >= 400 ? '\x1b[31m' : '\x1b[90m';
    console.log(
      `[${time}] ${color}${req.method.padEnd(6)}\x1b[0m ${req.originalUrl} ` +
      `${statusColor}${res.statusCode}\x1b[0m ${Date.now() - start}ms`
    );
  });
  next();
});

app.set('view engine', 'ejs');

app.set(
  'views',
  path.join(__dirname, 'views')
);

// Notifies open dashboards over /ws when data changes.
app.use('/api', require('./services/realtime').broadcastMutations);

app.use(
  '/api/auth',
  require('./routes/authRoutes')
);

app.use(
  '/api/employee-auth',
  require('./routes/employeeAuthRoutes')
);

app.use(
  '/api/employees',
  require('./routes/employeeRoutes')
);

app.use(
  '/api/departments',
  require('./routes/departmentRoutes')
);

app.use(
  '/api/employee-options',
  require('./routes/employeeOptionRoutes')
);

app.use(
  '/api/attendance',
  require('./routes/attendanceRoutes')
);

app.use(
  '/api/geofences',
  require('./routes/geofenceRoutes')
);

app.use(
  '/api/events',
  require('./routes/eventRoutes')
);

app.use(
  '/api/admin-notifications',
  require('./routes/adminNotificationRoutes')
);

app.use(
  '/api/ocr',
  require('./routes/ocrRoutes')
);

app.use(
  '/api/face',
  require('./routes/faceRoutes')
);

app.use(
  '/api/devices',
  require('./routes/deviceRoutes')
);

app.use(
  '/api/reports',
  require('./routes/reportRoutes')
);

app.use(
  '/api/certificates',
  require('./routes/certificateRoutes')
);

app.use(
  '/api/dashboard',
  require('./routes/dashboardRoutes')
);

app.use(
  '/api/ratings',
  require('./routes/ratingRoutes')
);

app.use(
  '/api/admin-accounts',
  require('./routes/adminAccountRoutes')
);

app.use(
  '/api/network',
  require('./routes/networkRoutes')
);

// Public certificate verification: /verify pages and /api/verify/:code/check.
app.use(require('./routes/verifyRoutes'));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'GeoAttend API is running.',
    environment: NODE_ENV
  });
});

// Called on each sidebar click so client-side navigation shows in the request log.

app.get('/api/nav/:section', (req, res) => {
  res.json({ success: true, section: req.params.section });
});

// One path per sidebar section (VIEW_PATHS in public/js/app.js).
const DASHBOARD_PATHS = [
  '/',
  '/dashboard',
  '/employees',
  '/departments',
  '/attendance',
  '/events',
  '/reports',
  '/geofences',
  '/verification',
  '/ratings',
  '/devices',
  '/settings'
];

app.get(DASHBOARD_PATHS, (req, res) => {
  res.render('dashboard', {
    googleMapsApiKey:
      process.env.GOOGLE_MAPS_API_KEY || '',

    defaultAdminEmail: config.email.defaultAdmin,

    // Hides "Sign in with Google" when unset.
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',

    emailDomain: config.email.domain
  });
});

app.get('/mobile', (req, res) => {
  res.render('mobile', {
    googleClientId:
      process.env.GOOGLE_CLIENT_ID || ''
  });
});

// Google Sign-In bridge for Expo Go / iOS, where Google rejects the app's own
// redirect. The ID token goes to `return`, so only app URL schemes are allowed.
const GOOGLE_BRIDGE_RETURN_SCHEMES = ['exp:', 'exps:', 'geoattendpro:', 'exp+geoattend-pro-mobile:'];

app.get('/mobile/google-signin', (req, res) => {
  let returnUrl = null;
  try {
    const parsed = new URL(String(req.query.return || ''));
    if (GOOGLE_BRIDGE_RETURN_SCHEMES.includes(parsed.protocol)) returnUrl = parsed.href.split('#')[0];
  } catch (e) {
  }
  if (!returnUrl) return res.status(400).send('Invalid return URL.');
  res.render('google-bridge', {
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    returnUrl
  });
});

app.use(notFound);

app.use(errorHandler);

// Schema upgrade failures are logged; the server still starts.
require('./services/schemaUpgrades').run()
  .catch((err) => console.error('Schema upgrade failed:', err.message))
  .finally(() => {
  const server = app.listen(PORT, () => {
  console.log('');
  console.log('==========================================');
  console.log('       GeoAttend Server');
  console.log('==========================================');
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log(
    `API: http://localhost:${PORT}/api/health`
  );
  console.log('==========================================');
  console.log('');

  // Preload face models; a failure surfaces again on the first face request.
  require('./services/faceService').warmUp()
    .then(() => console.log('Face recognition models loaded.'))
    .catch((err) => console.error('Face model warm-up failed:', err.message));

  require('./services/uploadStore').startDiskSync();

  // Time out sessions whose phone stopped sending heartbeats.
  const { closeSilentSessions } = require('./controllers/attendanceController');
  setInterval(closeSilentSessions, 5000);
  const { expireEndedEventAnomalies } = require('./controllers/attendanceController');
  setInterval(() => expireEndedEventAnomalies().catch(err => console.error('[anomalies] Expire failed:', err.message)), 30000);
  // Tell admin pages the moment an event starts or ends.
  const { announceEventBoundaries } = require('./services/realtime');
  setInterval(() => announceEventBoundaries().catch(err => console.error('[realtime] Event check failed:', err.message)), 5000);
  });

  require('./services/realtime').attach(server);
  });
