const pool = require('../config/db');
const faceService = require('../services/faceService');
const { logAction } = require('../services/auditService');
const { removeUpload } = require('../services/uploadStore');
const { recordVerificationAttendance } = require('./attendanceController');

// POST /api/face/verify (multipart: image, event_id?) — kiosk match; records attendance with event_id.
async function verifyFace(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'A face image is required.' });
    }

    // Reject requests that did not pass the client-side liveness check before
    // running the model.
    const livenessVerified = req.body.liveness_verified === 'true' || req.body.liveness_verified === true;
    const livenessActions = typeof req.body.liveness_actions === 'string' ? req.body.liveness_actions.slice(0, 120) : null;
    const eventId = req.body.event_id ? Number(req.body.event_id) : null;

    if (!livenessVerified) {
      return res.status(400).json({
        success: false,
        result: 'liveness_failed',
        message: 'Liveness check was not completed. Please retry the selfie verification.'
      });
    }

    const imagePath = `/uploads/faces/${req.file.filename}`;

    let embedding;
    try {
      embedding = await faceService.getEmbedding(req.file.path);
    } catch (err) {
      console.error('Face verification failed:', err.message);
      return res.status(502).json({
        success: false,
        message: err.message.includes('model not found')
          ? 'The face-recognition model is not installed on this server yet.'
          : 'Could not process the captured image. Please retake the photo.'
      });
    }

    const [rows] = await pool.query(
      `SELECT ef.employee_id, ef.embedding FROM employee_faces ef
       JOIN employees e ON e.id = ef.employee_id WHERE e.status != 'Inactive' AND e.is_approved = 1`
    );
    const candidates = rows.map((r) => ({ employeeId: r.employee_id, embedding: JSON.parse(r.embedding) }));

    const match = faceService.findBestMatch(embedding, candidates);

    let result = 'no_match';
    let matchedEmployee = null;
    const similarityPct = match ? Math.max(0, match.similarity) * 100 : null;

    if (match) {
      const [empRows] = await pool.query(
        `SELECT e.*, d.name AS department_name FROM employees e
         JOIN departments d ON e.department_id = d.id WHERE e.id = ?`,
        [match.employeeId]
      );
      if (empRows[0]) {
        matchedEmployee = empRows[0];
        result = matchedEmployee.status === 'Inactive' ? 'expired' : 'matched';
      }
    }

    const [insertResult] = await pool.query(
      `INSERT INTO face_records (employee_id, image_path, similarity, result, liveness_verified, liveness_actions)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [matchedEmployee ? matchedEmployee.id : null, imagePath, similarityPct, result, 1, livenessActions]
    );

    await logAction({
      adminId: req.admin ? req.admin.id : null,
      action: 'face_verify',
      module: 'face',
      details: { result, liveness_actions: livenessActions },
      ip: req.ip
    });

    let attendance = null;
    if (result === 'matched' && eventId) {
      try {
        attendance = await recordVerificationAttendance({
          employeeId: matchedEmployee.id,
          eventId,
          method: 'face',
          faceRecordId: insertResult.insertId,
          adminId: req.admin ? req.admin.id : null
        });
      } catch (attErr) {
        console.error('Face-triggered attendance recording failed:', attErr.message);
        attendance = { success: false, status: 500, message: 'Identity verified, but recording attendance failed. Please try again or record it manually.' };
      }
    }

    res.json({
      success: result === 'matched',
      result,
      faceRecordId: insertResult.insertId,
      similarity: similarityPct,
      livenessActions,
      employee: matchedEmployee
        ? {
            id: matchedEmployee.id,
            employee_code: matchedEmployee.employee_code,
            full_name: matchedEmployee.full_name,
            department: matchedEmployee.department_name
          }
        : null,
      attendance,
      message: faceResultMessage(result)
    });
  } catch (err) {
    next(err);
  }
}

function faceResultMessage(result) {
  const messages = {
    matched: 'Identity verified successfully.',
    no_match: 'No enrolled face matches this photo closely enough.',
    no_face_detected: 'No face was detected in the photo. Please retake it.',
    expired: 'This employee record is inactive.',
    liveness_failed: 'Liveness check was not completed. Please retry the selfie verification.'
  };
  return messages[result] || 'Verification failed.';
}

// GET /api/face/records
async function getFaceRecords(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT f.*, e.full_name, e.employee_code FROM face_records f
       LEFT JOIN employees e ON f.employee_id = e.id
       ORDER BY f.created_at DESC LIMIT 100`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/face/records/:id (mobile anomaly selfies are kept as evidence)
async function deleteFaceRecord(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT id, image_path, result, source FROM face_records WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Face check not found.' });
    const record = rows[0];

    await pool.query('DELETE FROM face_records WHERE id = ?', [record.id]);
    if (record.source !== 'mobile_anomaly' && String(record.image_path || '').startsWith('/uploads/faces/')) {
      await removeUpload(record.image_path).catch((err) =>
        console.error(`[Face] Could not delete photo ${record.image_path}:`, err.message));
    }

    await logAction({
      adminId: req.admin ? req.admin.id : null,
      action: 'delete',
      module: 'face',
      details: { face_record_id: record.id, result: record.result, source: record.source },
      ip: req.ip
    });
    res.json({ success: true, message: 'Face check deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { verifyFace, getFaceRecords, deleteFaceRecord };
