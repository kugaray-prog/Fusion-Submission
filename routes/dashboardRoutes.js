const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

router.use(requireAuth, requireRole('super_admin'));
router.get('/stats', dashboardController.getStats);
router.get('/department-attendance', dashboardController.getDepartmentAttendance);
router.get('/recent-activity', dashboardController.getRecentActivity);

module.exports = router;
