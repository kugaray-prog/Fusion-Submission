const express = require('express');
const router = express.Router();
const networkController = require('../controllers/networkController');
const { requireAuth, requireRole, requireEmployeeAuth } = require('../middleware/authMiddleware');

router.get('/check', requireEmployeeAuth, networkController.checkEmployeeNetwork);
router.get('/settings', requireAuth, requireRole('super_admin'), networkController.getSettings);
router.put('/settings', requireAuth, requireRole('super_admin'), networkController.updateSettings);

module.exports = router;
