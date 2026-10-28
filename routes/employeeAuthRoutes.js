const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { clientRateLimitOptions } = require('../middleware/rateLimitKey');
const employeeAuthController = require('../controllers/employeeAuthController');
const employeeOptionController = require('../controllers/employeeOptionController');
const { requireEmployeeAuth } = require('../middleware/authMiddleware');
const { uploadRegistration } = require('../middleware/uploadMiddleware');

// Only failed attempts count: everyone on campus Wi-Fi shares one public IP.
const loginLimiter = rateLimit({
  ...clientRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts. Please try again later.' }
});

router.post('/google', loginLimiter, employeeAuthController.googleLogin);
router.get('/departments', employeeAuthController.listDepartments);
router.get('/employee-options', employeeOptionController.getOptions);
// Creates/links the employee, registers the device and enrolls the face in one
// request ("image" required, "video" optional).
router.post(
  '/link-device',
  loginLimiter,
  uploadRegistration.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]),
  employeeAuthController.linkDevice
);
router.get('/device-status', requireEmployeeAuth, employeeAuthController.deviceStatus);

module.exports = router;
