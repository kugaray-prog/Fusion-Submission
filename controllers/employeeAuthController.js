const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { isBlockedStatus, sendDeviceBlocked, getBlockedStatus, cleanDeviceInfo } = require('../services/deviceAccess');
const config = require('../config/config');
const { logAction } = require('../services/auditService');
const { notifyAdmins, employeeLabel, deviceLabel } = require('../services/adminNotificationService');
const faceService = require('../services/faceService');

// Failed face matches allowed before new-device registration is locked, and lock duration.
const DOUBLESAFE_MAX_ATTEMPTS = 3;
const DOUBLESAFE_LOCK_MINUTES = 30;

let googleClient = null;
function getGoogleClient() {
  if (!process.env.GOOGLE_CLIENT_ID) return null;
  if (!googleClient) {
    const { OAuth2Client } = require('google-auth-library');
    googleClient = new OAuth2Client();
  }
  return googleClient;
}

// Accepted Google client IDs (web + Android).
function getAcceptedAudiences() {
  return [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_ANDROID_CLIENT_ID].filter(Boolean);
}

function employeePayload(employee) {
  return {
    id: employee.id,
    employee_code: employee.employee_code,
    full_name: employee.full_name,
    surname: employee.surname,
    given_name: employee.given_name,
    middle_name: employee.middle_name,
    suffix: employee.suffix,
    department: employee.department_name,
    position: employee.position,
    gender: employee.gender,
    classification: employee.classification,
    photo_path: employee.photo_path,
    // Registration photo, falling back to the admin-uploaded photo.
    face_photo_url: employee.face_photo_url || employee.photo_path || null
  };
}

// Image of the employee's latest registration photo.
async function getLatestFacePhoto(employeeId) {
  const [rows] = await pool.query(
    'SELECT image_path FROM employee_faces WHERE employee_id = ? ORDER BY created_at DESC LIMIT 1',
    [employeeId]
  );
  return rows[0] ? rows[0].image_path : null;
}

// Fallback when the client doesn't send its device UID.
async function getLatestDeviceStatus(employeeId) {
  const [rows] = await pool.query(
    `SELECT status FROM mobile_devices WHERE employee_id = ? ORDER BY registered_at DESC LIMIT 1`,
    [employeeId]
  );
  return rows[0] ? rows[0].status : null;
}

// Status of the device actually in use (an employee may have several).
async function getDeviceStatusFor(employeeId, deviceUid) {
  if (!deviceUid) return getLatestDeviceStatus(employeeId);
  const [rows] = await pool.query(
    `SELECT status FROM mobile_devices WHERE employee_id = ? AND device_uid = ?`,
    [employeeId, deviceUid]
  );
  return rows[0] ? rows[0].status : null;
}

function issueEmployeeToken(employee) {
  return jwt.sign(
    { id: employee.id, employee_code: employee.employee_code, type: 'employee' },
    config.jwt.secret,
    { expiresIn: '30d' }
  );
}

// POST /api/employee-auth/google { credential }
// Known email: log in. Unknown: return a short-lived pending token for registration.
async function googleLogin(req, res, next) {
  try {
    const client = getGoogleClient();
    if (!client) {
      return res.status(501).json({
        success: false,
        message: 'Google Sign-In is not configured on this server. Set GOOGLE_CLIENT_ID in .env to enable it.'
      });
    }

    const { credential, device_uid } = req.body;
    if (!credential) {
      return res.status(400).json({ success: false, message: 'Missing Google credential.' });
    }

    const ticket = await client.verifyIdToken({ idToken: credential, audience: getAcceptedAudiences() });
    const payload = ticket.getPayload();
    const email = payload.email;
    if (!payload.email_verified) {
      return res.status(403).json({ success: false, message: 'Your Google email is not verified.' });
    }

    const [rows] = await pool.query(
      `SELECT e.*, d.name AS department_name FROM employees e
       JOIN departments d ON e.department_id = d.id WHERE e.email = ?`,
      [email]
    );
    const employee = rows[0];

    if (employee) {
      if (employee.status === 'Inactive') {
        return res.status(403).json({ success: false, message: 'This account is inactive. Contact your administrator.' });
      }

      const deviceStatus = await getDeviceStatusFor(employee.id, device_uid);
      // A blacklisted/rejected device gets no token at all.
      if (isBlockedStatus(deviceStatus)) {
        await notifyAdmins({
          type: 'blocked_device_login', severity: 'danger', targetView: 'mobile-app', employeeId: employee.id,
          title: 'Sign-in from a blocked device',
          message: `${await employeeLabel(employee.id)} tried to sign in on a ${deviceStatus} device.`
        });
        return sendDeviceBlocked(res, deviceStatus);
      }

      // Unregistered device: go through registration (face re-check + device ownership check).
      if (deviceStatus) {
        const facePhotoUrl2 = await getLatestFacePhoto(employee.id);
        return res.json({
          success: true,
          matched: true,
          message: 'Login successful.',
          token: issueEmployeeToken(employee),
          employee: employeePayload({ ...employee, face_photo_url: facePhotoUrl2 }),
          deviceStatus
        });
      }

      if (device_uid) {
        await notifyAdmins({
          type: 'unregistered_device_login', severity: 'warning', targetView: 'mobile-app', employeeId: employee.id,
          title: 'Sign-in from an unregistered device',
          message: `${await employeeLabel(employee.id)} signed in with Google on a device that isn't registered to them. They must pass face re-verification to register it.`
        });
      }

      const pendingToken = jwt.sign(
        { type: 'google_pending', email, given_name: payload.given_name || '', family_name: payload.family_name || '' },
        config.jwt.secret,
        { expiresIn: '10m' }
      );
      return res.json({
        success: true,
        matched: false,
        pendingToken,
        google: { email, given_name: payload.given_name, family_name: payload.family_name },
        // Pre-fills RegistrationScreen.
        existingEmployee: {
          employee_code: employee.employee_code,
          surname: employee.surname || '',
          given_name: employee.given_name || '',
          middle_name: employee.middle_name || '',
          suffix: employee.suffix || '',
          department: employee.department_name || '',
          position: employee.position || '',
          gender: employee.gender || '',
          classification: employee.classification || 'Permanent Administrative'
        }
      });
    }

    // Not linked to any employee yet — issue a short-lived pending token proving
    // the email was verified, and let the client proceed to device registration.
    const pendingToken = jwt.sign(
      {
        type: 'google_pending',
        email,
        given_name: payload.given_name || '',
        family_name: payload.family_name || ''
      },
      config.jwt.secret,
      { expiresIn: '10m' }
    );

    res.json({
      success: true,
      matched: false,
      pendingToken,
      google: { email, given_name: payload.given_name, family_name: payload.family_name }
    });
  } catch (err) {
    if (err.message && err.message.includes('Token used too late')) {
      return res.status(401).json({ success: false, message: 'Your Google session expired. Please try again.' });
    }
    // Logged so audience/config mismatches (e.g. a forgotten GOOGLE_ANDROID_CLIENT_ID)
    // are visible in the server console instead of only as a generic 500 to the client.
    console.error('Google token verification failed:', err.message);
    next(err);
  }
}

// Allowed values for the (optional) name suffix dropdown, mirroring the admin dashboard.
const VALID_SUFFIXES = ['', 'Jr.', 'Sr.', 'II', 'III', 'IV', 'V'];

// Suggested values (keep in sync with RegistrationScreen); any text is accepted.
const KNOWN_CLASSIFICATIONS = [
  'Permanent Administrative', 'Permanent Academic', 'Casual Administrative',
  'COS Administrative', 'COS Academic', 'Job Order'
];

// GET /api/employee-auth/departments (public, for the registration form)
async function listDepartments(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT id, name FROM departments ORDER BY name ASC');
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// Short department codes sent by older app builds.
const DEPARTMENT_CODE_MAP = {
  CCS: 'College of Computer Studies',
  COE: 'College of Engineering',
  CBE: 'College of Business and Economics',
  CAS: 'College of Arts and Sciences'
};

// Department name/code -> id, creating the department if needed ("Unassigned" if empty).
async function resolveDepartmentId(deptInput) {
  const name = (DEPARTMENT_CODE_MAP[deptInput] || deptInput || '').trim() || 'Unassigned';

  const [existing] = await pool.query('SELECT id FROM departments WHERE name = ?', [name]);
  if (existing[0]) return existing[0].id;

  const [created] = await pool.query('INSERT INTO departments (name) VALUES (?)', [name]);
  return created.insertId;
}

// POST /api/employee-auth/link-device (multipart: image, video?)
// { pendingToken, employee_code, surname, given_name, middle_name, suffix,
//   department, device_uid, device_model, device_brand, device_os }
// Creates or links the employee, registers the device and enrolls the face.
// A new device for an employee with a face on file must match that face first
// (DoubleSafe); repeated failures lock registration for DOUBLESAFE_LOCK_MINUTES.
async function linkDevice(req, res, next) {
  try {
    const imageFile = req.files?.image?.[0];
    const videoFile = req.files?.video?.[0];
    if (!imageFile) {
      return res.status(400).json({ success: false, message: 'A face photo is required to complete registration.' });
    }

    const {
      pendingToken, employee_code, device_uid, device_model, device_brand, device_os,
      middle_name, suffix, department, position, classification, gender
    } = req.body;
    // The mobile app's registration form posts first_name/last_name; surname/given_name
    // are also accepted for backward compatibility with older/alternate clients.
    const surname = req.body.surname || req.body.last_name;
    const given_name = req.body.given_name || req.body.first_name;

    if (!pendingToken || !employee_code || !surname || !given_name || !device_uid) {
      return res.status(400).json({ success: false, message: 'Missing required registration details.' });
    }
    // Re-registering can't be used to get a blacklisted/rejected phone back in.
    const blockedStatus = await getBlockedStatus(device_uid);
    if (blockedStatus) return sendDeviceBlocked(res, blockedStatus);
    // Required fields (also enforced here since the API is public).
    if (!department || !department.trim()) {
      return res.status(400).json({ success: false, message: 'Department is required.' });
    }
    if (!position || !position.trim()) {
      return res.status(400).json({ success: false, message: 'Position is required.' });
    }
    if (!gender || !gender.trim()) {
      return res.status(400).json({ success: false, message: 'Gender is required.' });
    }
    if (!classification || !classification.trim()) {
      return res.status(400).json({ success: false, message: 'Classification is required.' });
    }
    if (suffix && !VALID_SUFFIXES.includes(suffix)) {
      return res.status(400).json({ success: false, message: 'Invalid suffix value.' });
    }
    if (classification.trim().length > 50) {
      return res.status(400).json({ success: false, message: 'Classification must be 50 characters or fewer.' });
    }
    if (gender.trim().length > 40) {
      return res.status(400).json({ success: false, message: 'Gender must be 40 characters or fewer.' });
    }

    // Registration requires a completed on-device liveness check.
    const livenessVerified = req.body.liveness_verified === 'true' || req.body.liveness_verified === true;
    const livenessActions = typeof req.body.liveness_actions === 'string' ? req.body.liveness_actions.slice(0, 120) : null;
    if (!livenessVerified) {
      return res.status(400).json({
        success: false,
        message: 'Liveness check was not completed. Please retry face registration.'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, config.jwt.secret);
    } catch (e) {
      return res.status(401).json({ success: false, message: 'Your Google sign-in has expired. Please sign in again.' });
    }
    if (decoded.type !== 'google_pending') {
      return res.status(400).json({ success: false, message: 'Invalid registration session.' });
    }

    const [rows] = await pool.query(
      `SELECT e.*, d.name AS department_name FROM employees e
       JOIN departments d ON e.department_id = d.id WHERE e.employee_code = ?`,
      [employee_code]
    );
    let employee = rows[0];

    // Embedding is reused for the DoubleSafe check and for enrollment.
    let embedding;
    try {
      embedding = await faceService.getEmbedding(imageFile.path);
    } catch (err) {
      console.error('Face processing failed:', err.message);
      return res.status(502).json({
        success: false,
        message: 'Could not process the face photo. Please retake it and try again.'
      });
    }

    // One face, one account: reject if the face is enrolled to another employee
    // who still has a device.
    const [otherFaceRows] = await pool.query(
      `SELECT ef.employee_id, ef.embedding FROM employee_faces ef
       WHERE ef.employee_id <> ?
         AND EXISTS (SELECT 1 FROM mobile_devices md WHERE md.employee_id = ef.employee_id)`,
      [employee ? employee.id : 0]
    );
    const faceOwner = faceService.findBestMatch(
      embedding,
      otherFaceRows.map((r) => ({ employeeId: r.employee_id, embedding: JSON.parse(r.embedding) }))
    );
    if (faceOwner) {
      await logAction({
        adminId: null,
        action: 'duplicate_face_registration',
        module: 'employee_auth',
        details: { employeeCode: employee_code, matchedEmployeeId: faceOwner.employeeId, similarity: faceOwner.similarity * 100 },
        ip: req.ip
      });
      return res.status(409).json({
        success: false,
        result: 'face_already_registered',
        message: 'This face is already registered to another account. Each person can only register one account. Contact your administrator if this isn\'t right.'
      });
    }

    const surnameVal = surname.trim();
    const givenNameVal = given_name.trim();
    const middleNameVal = middle_name ? middle_name.trim() : null;
    const suffixVal = suffix ? suffix.trim() : null;
    const fullName = [givenNameVal, middleNameVal, surnameVal, suffixVal].filter(Boolean).join(' ');

    if (employee) {
      // Employee ID must belong to the submitted surname.
      const employeeSurname = (employee.surname || employee.full_name?.split(' ').pop() || '').trim().toLowerCase();
      if (employeeSurname !== surnameVal.toLowerCase()) {
        return res.status(409).json({
          success: false,
          message: `Employee ID "${employee_code}" is already registered under a different name. Contact your administrator if this isn't you.`
        });
      }
      if (employee.status === 'Inactive') {
        return res.status(403).json({ success: false, message: 'This account is inactive. Contact your administrator.' });
      }

      // DoubleSafe: a new device must match the enrolled face before anything is updated.
      const [deviceRows] = await pool.query(
        'SELECT id FROM mobile_devices WHERE employee_id = ? AND device_uid = ?',
        [employee.id, device_uid]
      );
      const isNewDeviceForThisEmployee = deviceRows.length === 0;

      if (isNewDeviceForThisEmployee) {
        if (employee.face_locked_until && new Date(employee.face_locked_until) > new Date()) {
          const minsLeft = Math.max(1, Math.ceil((new Date(employee.face_locked_until) - new Date()) / 60000));
          return res.status(423).json({
            success: false,
            result: 'locked',
            message: `Too many failed identity checks. Try again in ${minsLeft} minute(s), or contact your administrator to unlock your account.`
          });
        }

        const [faceRows] = await pool.query('SELECT embedding FROM employee_faces WHERE employee_id = ?', [employee.id]);
        if (faceRows.length > 0) {
          const candidates = faceRows.map((r) => ({ employeeId: employee.id, embedding: JSON.parse(r.embedding) }));
          const match = faceService.findBestMatch(embedding, candidates);
          const bestSimilarity = Math.max(...candidates.map((c) => faceService.cosineSimilarity(embedding, c.embedding)));
          const similarityPct = Math.max(0, bestSimilarity) * 100;
          const imagePathForLog = `/uploads/faces/${imageFile.filename}`;

          if (!match) {
            const attempts = (employee.face_failed_attempts || 0) + 1;
            const locked = attempts >= DOUBLESAFE_MAX_ATTEMPTS;
            await pool.query(
              `UPDATE employees SET face_failed_attempts = ?, face_locked_until = ?, face_lock_reason = ? WHERE id = ?`,
              [
                attempts,
                locked ? new Date(Date.now() + DOUBLESAFE_LOCK_MINUTES * 60000) : null,
                locked ? 'Too many failed DoubleSafe verification attempts during new device registration.' : null,
                employee.id
              ]
            );
            await pool.query(
              `INSERT INTO device_verification_attempts (employee_id, device_uid, image_path, similarity, result, liveness_verified, liveness_actions)
               VALUES (?, ?, ?, ?, ?, 1, ?)`,
              [employee.id, device_uid, imagePathForLog, similarityPct, locked ? 'locked' : 'no_match', livenessActions]
            );
            await logAction({
              adminId: null,
              action: 'doublesafe_failed',
              module: 'employee_auth',
              details: { employeeCode: employee_code, attempts, locked, similarity: similarityPct },
              ip: req.ip
            });

            if (locked) {
              await notifyAdmins({
                type: 'doublesafe_locked', severity: 'danger', targetView: 'employees', employeeId: employee.id,
                title: 'Account locked after failed face checks',
                message: `${await employeeLabel(employee.id)} failed face re-verification ${attempts} times while registering a new device and is locked for ${DOUBLESAFE_LOCK_MINUTES} minutes.`
              });
              return res.status(423).json({
                success: false,
                result: 'locked',
                message: `Too many failed identity checks. Your account is temporarily locked for ${DOUBLESAFE_LOCK_MINUTES} minutes. Contact your administrator if you need immediate access.`
              });
            }
            return res.status(401).json({
              success: false,
              result: 'no_match',
              message: `We couldn't confirm this is you (attempt ${attempts} of ${DOUBLESAFE_MAX_ATTEMPTS}). Make sure you're centered in frame and well-lit, then try again.`
            });
          }

          // Matched — clear any prior failures and log the successful check.
          await pool.query(
            'UPDATE employees SET face_failed_attempts = 0, face_locked_until = NULL, face_lock_reason = NULL WHERE id = ?',
            [employee.id]
          );
          await pool.query(
            `INSERT INTO device_verification_attempts (employee_id, device_uid, image_path, similarity, result, liveness_verified, liveness_actions)
             VALUES (?, ?, ?, ?, 'matched', 1, ?)`,
            [employee.id, device_uid, imagePathForLog, similarityPct, livenessActions]
          );
          await logAction({
            adminId: null,
            action: 'doublesafe_verified',
            module: 'employee_auth',
            details: { employeeCode: employee_code, similarity: similarityPct },
            ip: req.ip
          });
        }
        // No enrolled face yet: treated as first enrollment.
      }

      // Sync name, Google email, department and position from the form.
      const departmentId = await resolveDepartmentId(department);
      const classificationVal = classification || employee.classification;
      const genderVal = gender || employee.gender;
      await pool.query(
        `UPDATE employees SET surname = ?, given_name = ?, middle_name = ?, suffix = ?, full_name = ?,
                email = COALESCE(email, ?), department_id = ?, position = COALESCE(?, position),
                classification = ?, gender = ?
         WHERE id = ?`,
        [surnameVal, givenNameVal, middleNameVal, suffixVal, fullName, decoded.email, departmentId, position || null, classificationVal, genderVal, employee.id]
      );
      employee.surname = surnameVal;
      employee.given_name = givenNameVal;
      employee.middle_name = middleNameVal;
      employee.suffix = suffixVal;
      employee.full_name = fullName;
    } else {
      // First registration: create the employee record.
      const departmentId = await resolveDepartmentId(department);

      const [result] = await pool.query(
        // is_approved = 0: kept out of the Employees list until an admin
        // approves this registration's device (deviceController.updateDeviceStatus).
        `INSERT INTO employees (employee_code, full_name, surname, given_name, middle_name, suffix, department_id, position, gender, classification, email, status, remark, is_approved)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Full-time', 'Active', 0)`,
        [employee_code, fullName, surnameVal, givenNameVal, middleNameVal, suffixVal, departmentId, position || null, gender || null, classification || 'Permanent Administrative', decoded.email]
      );

      const [newRows] = await pool.query(
        `SELECT e.*, d.name AS department_name FROM employees e
         JOIN departments d ON e.department_id = d.id WHERE e.id = ?`,
        [result.insertId]
      );
      employee = newRows[0];

      await logAction({
        adminId: null,
        action: 'self_register',
        module: 'employees',
        details: { employeeCode: employee_code, email: decoded.email, livenessActions },
        ip: req.ip
      });
    }

    // Enroll the captured face (step 3 of the registration sequence).
    const imagePath = `/uploads/faces/${imageFile.filename}`;
    const videoPath = videoFile ? `/uploads/face_videos/${videoFile.filename}` : null;
    await pool.query(
      `INSERT INTO employee_faces (employee_id, image_path, video_path, embedding, model_name) VALUES (?, ?, ?, ?, ?)`,
      [employee.id, imagePath, videoPath, JSON.stringify(embedding), 'insightface_buffalo_l/w600k_r50']
    );

    // Register the device (one employee per device, many devices per employee).
    const [existingDevice] = await pool.query('SELECT * FROM mobile_devices WHERE device_uid = ?', [device_uid]);
    let deviceStatus = 'pending';
    if (existingDevice[0]) {
      if (String(existingDevice[0].employee_id) !== String(employee.id)) {
        return res.status(409).json({
          success: false,
          message: 'This device is already registered to another employee. Contact your administrator if this isn\'t you.'
        });
      }
      deviceStatus = existingDevice[0].status;
    } else {
      const info = cleanDeviceInfo({ model: device_model, brand: device_brand, os: device_os });
      await pool.query(
        `INSERT INTO mobile_devices (employee_id, device_uid, model, brand, os, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        [employee.id, device_uid, info.model, info.brand, info.os]
      );
      const device = deviceLabel({ brand: device_brand, model: device_model, device_uid });
      await notifyAdmins({
        type: 'device_registration', severity: 'info', targetView: 'mobile-app', employeeId: employee.id, dedupe: false,
        title: employee.is_approved ? 'New device awaiting approval' : 'New employee registration',
        message: employee.is_approved
          ? `${await employeeLabel(employee.id)} registered a new phone (${device}). Approve it in Device Management.`
          : `${await employeeLabel(employee.id)} registered in the mobile app with ${device}. Approve the device to add them to Employees.`
      });
    }

    const facePhotoUrl3 = await getLatestFacePhoto(employee.id);
    res.status(201).json({
      success: true,
      message: deviceStatus === 'approved' ? 'Device confirmed.' : 'Face registered — device pending admin approval.',
      token: issueEmployeeToken(employee),
      employee: employeePayload({ ...employee, face_photo_url: facePhotoUrl3 }),
      deviceStatus
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/employee-auth/device-status (polled by the waiting-for-approval screen)
async function deviceStatus(req, res, next) {
  try {
    const status = await getDeviceStatusFor(req.employee.id, req.query.device_uid);
    res.json({ success: true, deviceStatus: status });
  } catch (err) {
    next(err);
  }
}

module.exports = { googleLogin, linkDevice, deviceStatus, listDepartments };
