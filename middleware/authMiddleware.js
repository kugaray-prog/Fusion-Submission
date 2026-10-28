const jwt = require('jsonwebtoken');
const config = require('../config/config');
const pool = require('../config/db');
const { getBlockedStatus, sendDeviceBlocked } = require('../services/deviceAccess');

// Admin JWT (header or cookie); the account must still exist and be active.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const bearerToken = header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  const token = bearerToken || (req.cookies && req.cookies.token) || req.query.token;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session. Please log in again.' });
  }
  if (decoded.type === 'employee' || decoded.type === 'google_pending') {
    return res.status(403).json({ success: false, message: 'This endpoint requires an admin session.' });
  }

  try {
    const [rows] = await pool.query('SELECT id, role, is_active FROM admin_accounts WHERE id = ?', [decoded.id]);
    const admin = rows[0];
    if (!admin || !admin.is_active) {
      return res.status(401).json({ success: false, message: 'Your account is no longer active. Please contact an administrator.' });
    }
    // Role comes from the database so role changes apply on the next request.
    req.admin = { ...decoded, role: admin.role };
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

// Employee JWT; blocked devices (X-Device-Uid) get DEVICE_BLOCKED.
async function requireEmployeeAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session. Please log in again.' });
  }
  if (decoded.type !== 'employee') {
    return res.status(403).json({ success: false, message: 'Invalid token type for this route.' });
  }

  try {
    const blockedStatus = await getBlockedStatus(req.headers['x-device-uid'], decoded.id);
    if (blockedStatus) return sendDeviceBlocked(res, blockedStatus);
  } catch (err) {
    return next(err);
  }
  req.employee = decoded;
  next();
}

module.exports = { requireAuth, requireRole, requireEmployeeAuth };
