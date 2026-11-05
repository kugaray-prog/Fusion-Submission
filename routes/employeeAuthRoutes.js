const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { clientRateLimitOptions } = require('../middleware/rateLimitKey');
const employeeAuthController = require('../controllers/employeeAuthController');
const employeeOptionController = require('../controllers/employeeOptionController');
const { requireEmployeeAuth } = require('../middleware/authMiddleware');
const { uploadRegistration } = require('../middleware/uploadMiddleware');

// Only failed attempts count. Everyone on campus Wi-Fi shares one public IP, so
// the per-IP cap must cover a whole crowd's typos and expired sign-ins.
const loginLimiter = rateLimit({
  ...clientRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_FAILED_LIMIT_PER_IP) || 150,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts. Please try again later.' }
});

// Registration failures are counted per Google account (from the signed
// pendingToken), so one person's retakes don't lock out the rest of the campus.
// Runs after multer, which parses the multipart body.
const registrationLimiter = rateLimit({
  ...clientRateLimitOptions,
  keyGenerator: (req) => {
    try {
      const decoded = jwt.verify(req.body && req.body.pendingToken, config.jwt.secret);
      if (decoded && decoded.type === 'google_pending' && decoded.email) return `google:${decoded.email}`;
    } catch (e) {
    }
    return clientRateLimitOptions.keyGenerator(req);
  },
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many registration attempts. Please try again later.' }
});

router.post('/google', loginLimiter, employeeAuthController.googleLogin);
router.get('/departments', employeeAuthController.listDepartments);
router.get('/employee-options', employeeOptionController.getOptions);
// Creates/links the employee, registers the device and enrolls the face in one
// request ("image" required, "video" optional).
router.post(
  '/link-device',
  uploadRegistration.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]),
  registrationLimiter,
  employeeAuthController.linkDevice
);
router.get('/device-status', requireEmployeeAuth, employeeAuthController.deviceStatus);

module.exports = router;
