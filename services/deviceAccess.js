const pool = require('../config/db');

// Statuses that lock a phone out. 'removed' is not stored: it means the
// signed-in phone's device record was deleted by an admin.
const BLOCKED_STATUSES = ['blacklisted', 'rejected', 'removed'];

function isBlockedStatus(status) {
  return BLOCKED_STATUSES.includes(status);
}

function blockedMessage(status) {
  if (status === 'blacklisted') {
    return 'This device has been blacklisted by your administrator, so it can no longer be used to sign in or record attendance. Contact your administrator if you think this is a mistake.';
  }
  if (status === 'removed') {
    return 'This device was removed by your administrator. Sign in again to register it.';
  }
  return "This device's registration was rejected by your administrator, so it can't be used to sign in or record attendance. Contact your administrator.";
}

// 403 with code DEVICE_BLOCKED, which makes the mobile app sign out.
function sendDeviceBlocked(res, status) {
  return res.status(403).json({
    success: false,
    code: 'DEVICE_BLOCKED',
    deviceStatus: status,
    message: blockedMessage(status)
  });
}

// Returns the blocked status or null. With employeeId, the device must still
// exist for that employee, otherwise it is 'removed'.
async function getBlockedStatus(deviceUid, employeeId = null) {
  if (!deviceUid) return null;
  const [rows] = employeeId == null
    ? await pool.query('SELECT status FROM mobile_devices WHERE device_uid = ?', [deviceUid])
    : await pool.query('SELECT status FROM mobile_devices WHERE device_uid = ? AND employee_id = ?', [deviceUid, employeeId]);
  if (!rows[0]) return employeeId == null ? null : 'removed';
  return isBlockedStatus(rows[0].status) ? rows[0].status : null;
}

// Trims device details to column sizes (some Android builds report a full
// build fingerprint as the OS name).
function cleanDeviceInfo({ model, brand, os }) {
  const clip = (v, max) => {
    const s = v == null ? '' : String(v).trim();
    return s ? s.slice(0, max) : null;
  };
  return { model: clip(model, 120), brand: clip(brand, 120), os: clip(os, 60) };
}

module.exports = { isBlockedStatus, blockedMessage, sendDeviceBlocked, getBlockedStatus, cleanDeviceInfo };
