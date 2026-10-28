const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

// Readable by the Verification-only 'admin' role for the event picker.
// Must stay above the super_admin-only router.use below.
router.get('/ongoing', requireAuth, requireRole('super_admin', 'admin'), eventController.getOngoingEvents);

router.use(requireAuth, requireRole('super_admin'));
router.get('/', eventController.getAllEvents);
router.delete('/:id', eventController.deleteEvent);

module.exports = router;
