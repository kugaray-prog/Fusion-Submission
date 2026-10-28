const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

router.use(requireAuth, requireRole('super_admin'));

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const [rows] = await pool.query(
      `SELECT id, type, severity, title, message, target_view, employee_id, is_read, created_at
       FROM admin_notifications ORDER BY created_at DESC, id DESC LIMIT ?`,
      [limit]
    );
    const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM admin_notifications WHERE is_read = 0');
    res.json({ success: true, data: rows, unread: Number(unread) });
  } catch (err) {
    next(err);
  }
});

router.patch('/read-all', async (req, res, next) => {
  try {
    await pool.query('UPDATE admin_notifications SET is_read = 1 WHERE is_read = 0');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    await pool.query('UPDATE admin_notifications SET is_read = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Clears all read notifications.
router.delete('/', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM admin_notifications WHERE is_read = 1');
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
