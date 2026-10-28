const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { clientRateLimitOptions } = require('../middleware/rateLimitKey');
const authController = require('../controllers/authController');

// Only failed attempts count, so admins on the same IP don't block each other.
const loginLimiter = rateLimit({
  ...clientRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' }
});

router.post('/google', loginLimiter, authController.googleLogin);
router.post('/logout', authController.logout);

module.exports = router;
