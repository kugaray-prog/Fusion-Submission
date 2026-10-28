const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

router.use(requireAuth, requireRole('super_admin'));
router.get('/', reportController.generateReport);
router.get('/insights', reportController.getInsights);
router.get('/export/:format', reportController.exportReport);

module.exports = router;
