const express = require('express');
const router = express.Router();
const verifyController = require('../controllers/verifyController');

// Public (no login): certificate verification from the QR code.
router.get('/verify', verifyController.showVerifyPage);
router.get('/verify/:code', verifyController.showVerifyPage);
router.post(
  '/api/verify/:code/check',
  express.raw({ type: () => true, limit: '15mb' }),
  verifyController.checkCertificateFile
);

module.exports = router;
