const express = require('express');
const router = express.Router();
const deviceController = require('../controllers/deviceController');
const { requireAuth, requireRole, requireEmployeeAuth } = require('../middleware/authMiddleware');

router.post('/register', requireEmployeeAuth, deviceController.registerDevice);
router.put('/push-token', requireEmployeeAuth, deviceController.savePushToken);
router.get('/', requireAuth, requireRole('super_admin'), deviceController.getDevices);
router.post('/bulk', requireAuth, requireRole('super_admin'), deviceController.bulkDeviceAction);
router.patch('/:id/status', requireAuth, requireRole('super_admin'), deviceController.updateDeviceStatus);
router.delete('/:id', requireAuth, requireRole('super_admin'), deviceController.deleteDevice);

module.exports = router;
