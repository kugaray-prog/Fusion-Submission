const express = require('express');
const router = express.Router();
const adminAccountController = require('../controllers/adminAccountController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

router.use(requireAuth, requireRole('super_admin'));

router.get('/', adminAccountController.getAdminAccounts);
router.post('/send-otp', adminAccountController.sendAdminOtp);
router.post('/', adminAccountController.createAdminAccount);
router.patch('/:id', adminAccountController.updateAdminAccount);
router.delete('/:id', adminAccountController.deleteAdminAccount);

module.exports = router;
