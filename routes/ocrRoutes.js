const express = require('express');
const router = express.Router();
const ocrController = require('../controllers/ocrController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { uploadOcr } = require('../middleware/uploadMiddleware');

router.use('/records', requireAuth, requireRole('super_admin', 'admin'));
router.use('/verify', requireAuth, requireRole('super_admin', 'admin'));

router.post('/verify', uploadOcr.single('image'), ocrController.verifyId);
router.get('/records', ocrController.getOcrRecords);
router.delete('/records/:id', ocrController.deleteOcrRecord);

module.exports = router;
