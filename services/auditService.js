const pool = require('../config/db');

/** Records an entry in audit_logs. Never throws. */
async function logAction({ adminId = null, action, module, details = null, ip = null }) {
  const detailsJson = details ? JSON.stringify(details) : null;
  try {
    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)`,
      [adminId, action, module, detailsJson, ip]
    );
  } catch (err) {
    // The admin was deleted between requireAuth and this insert: log without an admin.
    if (adminId !== null && /foreign key constraint fails/i.test(err.message)) {
      try {
        await pool.query(
          `INSERT INTO audit_logs (admin_id, action, module, details, ip_address) VALUES (NULL, ?, ?, ?, ?)`,
          [action, module, detailsJson, ip]
        );
        return;
      } catch (retryErr) {
        console.error('Audit log write failed (retry with NULL admin_id also failed):', retryErr.message);
        return;
      }
    }
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { logAction };
