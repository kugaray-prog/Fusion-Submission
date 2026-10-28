const pool = require('../config/db');
const { logAction } = require('../services/auditService');
const { isBlockedStatus, blockedMessage, cleanDeviceInfo } = require('../services/deviceAccess');
const realtime = require('../services/realtime');
const { isExpoToken } = require('../services/pushService');

// GET /api/devices (each paired with the face photo taken at its registration)
async function getDevices(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT md.*, e.full_name, e.employee_code, e.position, e.classification,
              e.status AS employee_status, e.remark AS employee_remark,
              e.email, e.phone, e.is_approved AS employee_approved, d.name AS department_name,
              matched_face.image_path AS face_image_path,
              matched_face.created_at AS face_captured_at
       FROM mobile_devices md
       JOIN employees e ON md.employee_id = e.id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN (
         SELECT md2.id AS device_id, ef.image_path, ef.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY md2.id
                  ORDER BY ABS(TIMESTAMPDIFF(SECOND, ef.created_at, md2.registered_at)) ASC
                ) AS rn
         FROM mobile_devices md2
         JOIN employee_faces ef ON ef.employee_id = md2.employee_id
       ) matched_face ON matched_face.device_id = md.id AND matched_face.rn = 1
       ORDER BY md.registered_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/devices/register  (called by the mobile app on first login)
async function registerDevice(req, res, next) {
  try {
    const { employee_id, device_uid, model, brand, os } = req.body;
    if (!employee_id || !device_uid) {
      return res.status(400).json({ success: false, message: 'employee_id and device_uid are required.' });
    }
    if (Number(employee_id) !== Number(req.employee.id)) {
      return res.status(403).json({ success: false, message: 'You can only register your own device.' });
    }

    // The phone's cached employee_id may be stale; fail clearly instead of
    // hitting the foreign key.
    const [employeeRows] = await pool.query('SELECT id FROM employees WHERE id = ?', [employee_id]);
    if (!employeeRows[0]) {
      return res.status(404).json({
        success: false,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Your account could not be found. Please sign out and sign in again.'
      });
    }

    const [existing] = await pool.query('SELECT * FROM mobile_devices WHERE device_uid = ?', [device_uid]);
    if (existing[0]) {
      // A device belongs to one employee only.
      if (String(existing[0].employee_id) !== String(employee_id)) {
        return res.status(409).json({
          success: false,
          message: 'This device is already registered to another employee.'
        });
      }
      return res.json({ success: true, message: 'Device already registered.', data: existing[0] });
    }

    const info = cleanDeviceInfo({ model, brand, os });
    const [result] = await pool.query(
      `INSERT INTO mobile_devices (employee_id, device_uid, model, brand, os, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [employee_id, device_uid, info.model, info.brand, info.os]
    );

    res.status(201).json({ success: true, message: 'Device registered and pending admin approval.', data: { id: result.insertId } });
  } catch (err) {
    next(err);
  }
}

// PUT /api/devices/push-token { token } — null clears it.
async function savePushToken(req, res, next) {
  try {
    const deviceUid = req.headers['x-device-uid'];
    const token = req.body.token || null;
    if (!deviceUid) return res.status(400).json({ success: false, message: 'Device id is required.' });
    if (token && !isExpoToken(token)) return res.status(400).json({ success: false, message: 'Invalid push token.' });

    if (token) await pool.query('UPDATE mobile_devices SET push_token = NULL WHERE push_token = ? AND device_uid <> ?', [token, deviceUid]);
    const [result] = await pool.query(
      'UPDATE mobile_devices SET push_token = ? WHERE device_uid = ? AND employee_id = ?',
      [token, deviceUid, req.employee.id]
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'This device is not registered to your account.' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

const DEVICE_STATUSES = ['pending', 'approved', 'rejected', 'blacklisted'];

// Sets a device's status and sends its notifications. Returns false if not found.
async function applyDeviceStatus(id, status, req) {
  const [deviceRows] = await pool.query('SELECT employee_id, status, model FROM mobile_devices WHERE id = ?', [id]);
  const device = deviceRows[0];
  if (!device) return false;

  await pool.query('UPDATE mobile_devices SET status = ? WHERE id = ?', [status, id]);
  // Approving a self-registered employee's device approves the employee.
  if (status === 'approved') {
    await pool.query('UPDATE employees SET is_approved = 1 WHERE id = ?', [device.employee_id]);
    if (device.status !== 'approved') {
      await pool.query(
        `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Device Registered', ?, 'device_approved')`,
        [device.employee_id, `Your phone${device.model ? ` (${device.model})` : ''} has been approved. You can now record attendance with it.`]
      );
    }
  }
  await logAction({ adminId: req.admin.id, action: 'update_status', module: 'devices', details: { id, status }, ip: req.ip });

  if (isBlockedStatus(status) && device.status !== status) {
    await pool.query(
      `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, ?, ?, 'device_blocked')`,
      [device.employee_id, status === 'blacklisted' ? 'Device Blacklisted' : 'Device Rejected', blockedMessage(status)]
    );
  }
  realtime.notifyEmployee(device.employee_id, 'device');
  return true;
}

// Also deletes an unapproved self-registered employee whose only device this was.
async function removeDevice(id, req) {
  const [rows] = await pool.query(
    `SELECT md.id, md.employee_id, md.device_uid, e.is_approved, e.employee_code
     FROM mobile_devices md JOIN employees e ON e.id = md.employee_id WHERE md.id = ?`,
    [id]
  );
  const device = rows[0];
  if (!device) return null;

  await pool.query('DELETE FROM mobile_devices WHERE id = ?', [device.id]);

  let employeeRemoved = false;
  if (!device.is_approved) {
    const [[{ remaining }]] = await pool.query('SELECT COUNT(*) AS remaining FROM mobile_devices WHERE employee_id = ?', [device.employee_id]);
    if (remaining === 0) {
      await pool.query('DELETE FROM employees WHERE id = ? AND is_approved = 0', [device.employee_id]);
      employeeRemoved = true;
    }
  }

  await logAction({
    adminId: req.admin.id, action: 'delete', module: 'devices',
    details: { id: device.id, deviceUid: device.device_uid, employeeCode: device.employee_code, pendingRegistrationRemoved: employeeRemoved },
    ip: req.ip
  });
  realtime.notifyEmployee(device.employee_id, 'device');
  return { employeeRemoved };
}

// PATCH /api/devices/:id/status  { status: 'approved'|'rejected'|'blacklisted' }
async function updateDeviceStatus(req, res, next) {
  try {
    const { status } = req.body;
    if (!DEVICE_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value.' });
    }
    const found = await applyDeviceStatus(Number(req.params.id), status, req);
    if (!found) return res.status(404).json({ success: false, message: 'Device not found.' });
    res.json({ success: true, message: `Device marked as ${status}.` });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/devices/:id
async function deleteDevice(req, res, next) {
  try {
    const result = await removeDevice(Number(req.params.id), req);
    if (!result) return res.status(404).json({ success: false, message: 'Device not found.' });
    res.json({
      success: true,
      message: result.employeeRemoved ? 'Device and pending registration deleted.' : 'Device deleted.',
      data: result
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/devices/bulk { ids, action: 'approve'|'blacklist'|'delete' }
async function bulkDeviceAction(req, res, next) {
  try {
    const { action } = req.body;
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return res.status(400).json({ success: false, message: 'Select at least one device.' });
    if (ids.length > 500) return res.status(400).json({ success: false, message: 'Too many devices in one request (max 500).' });

    let done = 0;
    if (action === 'approve' || action === 'blacklist') {
      const status = action === 'approve' ? 'approved' : 'blacklisted';
      for (const id of ids) if (await applyDeviceStatus(id, status, req)) done++;
      return res.json({ success: true, message: `${done} device${done === 1 ? '' : 's'} marked as ${status}.`, data: { count: done } });
    }
    if (action === 'delete') {
      let registrationsRemoved = 0;
      for (const id of ids) {
        const result = await removeDevice(id, req);
        if (!result) continue;
        done++;
        if (result.employeeRemoved) registrationsRemoved++;
      }
      const extra = registrationsRemoved ? ` (${registrationsRemoved} pending registration${registrationsRemoved === 1 ? '' : 's'} removed)` : '';
      return res.json({ success: true, message: `${done} device${done === 1 ? '' : 's'} deleted${extra}.`, data: { count: done, registrationsRemoved } });
    }
    res.status(400).json({ success: false, message: 'Invalid action.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getDevices, registerDevice, savePushToken, updateDeviceStatus, deleteDevice, bulkDeviceAction };
