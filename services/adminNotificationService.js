const pool = require('../config/db');

// Admin notification bell alerts. notifyAdmins never throws, so a failed alert
// never fails the employee request that triggered it.

// Identical alerts within this window are skipped to avoid flooding on retries.
const DEDUPE_MINUTES = 10;

async function notifyAdmins({ type, severity = 'info', title, message, targetView = null, employeeId = null, dedupe = true }) {
  try {
    if (dedupe) {
      const [dup] = await pool.query(
        `SELECT id FROM admin_notifications
         WHERE type = ? AND title = ? AND employee_id <=> ? AND created_at >= NOW() - INTERVAL ? MINUTE LIMIT 1`,
        [type, title, employeeId, DEDUPE_MINUTES]
      );
      if (dup[0]) return;
    }
    await pool.query(
      `INSERT INTO admin_notifications (type, severity, title, message, target_view, employee_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [type, severity, title, message, targetView, employeeId]
    );
    require('./realtime').broadcast('notifications');
  } catch (err) {
    console.error('[adminNotifications] Could not save alert:', err.message);
  }
}

async function employeeLabel(employeeId) {
  try {
    const [rows] = await pool.query('SELECT full_name, employee_code FROM employees WHERE id = ?', [employeeId]);
    if (!rows[0]) return 'An employee';
    return rows[0].employee_code ? `${rows[0].full_name} (${rows[0].employee_code})` : rows[0].full_name;
  } catch (err) {
    return 'An employee';
  }
}

function deviceLabel({ brand, model, device_uid: uid } = {}) {
  const name = [brand, model].filter(Boolean).join(' ');
  if (name) return name;
  return uid ? `device ${String(uid).slice(0, 12)}` : 'an unknown device';
}

module.exports = { notifyAdmins, employeeLabel, deviceLabel };
