const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const { requireAuth, requireEmployeeAuth, requireRole } = require('../middleware/authMiddleware');
const { uploadRegistration } = require('../middleware/uploadMiddleware');

router.post('/submit', requireEmployeeAuth, attendanceController.submitAttendance);
router.get('/my-history', requireEmployeeAuth, attendanceController.getMyHistory);
router.post('/:id/face-verify', requireEmployeeAuth, uploadRegistration.fields([{ name: 'selfie', maxCount: 1 }, { name: 'video', maxCount: 1 }]), attendanceController.faceVerify);
router.post('/:id/heartbeat', requireEmployeeAuth, attendanceController.heartbeat);

router.get('/', requireAuth, requireRole('super_admin'), attendanceController.getAttendance);
router.get('/by-event', requireAuth, requireRole('super_admin'), attendanceController.getAttendanceByEvent);
router.get('/anomalies', requireAuth, requireRole('super_admin'), attendanceController.getAnomalies);
router.get('/anomaly-rechecks', requireAuth, requireRole('super_admin'), attendanceController.getAnomalyRechecks);
router.get('/:id/sessions/admin', requireAuth, requireRole('super_admin'), attendanceController.getSessionsAdmin);
router.patch('/:id', requireAuth, requireRole('super_admin'), attendanceController.updateAttendance);
router.delete('/:id', requireAuth, requireRole('super_admin'), attendanceController.deleteAttendance);

module.exports = router;
