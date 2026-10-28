const express = require('express');
const router = express.Router();
const ratingController = require('../controllers/ratingController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

router.use(requireAuth, requireRole('super_admin'));

router.get('/', ratingController.getRatings);
router.get('/performance', ratingController.getPerformance);
router.patch('/', ratingController.upsertRating);

module.exports = router;
