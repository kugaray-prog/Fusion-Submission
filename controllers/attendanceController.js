const pool = require('../config/db');
const { localDate } = require('../services/dateService');
const geofenceService = require('../services/geofenceService');
const faceService = require('../services/faceService');
const config = require('../config/config');
const { logAction } = require('../services/auditService');
const { notifyAdmins, employeeLabel, deviceLabel } = require('../services/adminNotificationService');
const realtime = require('../services/realtime');
const eventAudience = require('../services/eventAudience');

// `mocked` as sent by the mobile app (Android's mock-location flag).
function isMockedLocation(mocked) {
  return config.attendance.rejectMockLocations && (mocked === true || mocked === 'true');
}

// Accuracy allowance at the geofence edge, capped at edgeToleranceMeters.
function edgeTolerance(accuracy) {
  const acc = Number(accuracy);
  if (!Number.isFinite(acc) || acc <= 0) return 0;
  return Math.min(acc, config.attendance.edgeToleranceMeters);
}

// Runs non-critical work after the response is sent; errors are only logged.
function afterResponse(label, work) {
  Promise.resolve()
    .then(work)
    .catch((err) => console.error(`[attendance] ${label} failed:`, err.message));
}

// Stops the duration clock while a record awaits face verification; the row stays open.
async function pauseOpenSession(attendanceId) {
  const [openRows] = await pool.query(
    'SELECT id FROM attendance_sessions WHERE attendance_id = ? AND time_out IS NULL ORDER BY time_in DESC LIMIT 1',
    [attendanceId]
  );
  const openSession = openRows[0];
  if (!openSession) return;
  // `time_out IS NULL` keeps concurrent closes from double-counting duration.
  const [closed] = await pool.query(
    `UPDATE attendance_sessions
     SET time_out = NOW(), duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, time_in, NOW()))
     WHERE id = ? AND time_out IS NULL`,
    [openSession.id]
  );
  if (closed.affectedRows === 0) return; // someone else closed (and counted) it first
  const [[updatedSession]] = await pool.query('SELECT duration_seconds FROM attendance_sessions WHERE id = ?', [openSession.id]);
  const sessionDurationSeconds = updatedSession ? updatedSession.duration_seconds : 0;
  await pool.query(
    `UPDATE attendance SET total_duration_seconds = COALESCE(total_duration_seconds, 0) + ?,
       work_hours = ROUND(total_duration_seconds / 3600, 2) WHERE id = ?`,
    [sessionDurationSeconds, attendanceId]
  );
  await pool.query(
    `INSERT INTO attendance_logs (attendance_id, employee_id, action, details)
     SELECT id, employee_id, 'duration_paused', ? FROM attendance WHERE id = ?`,
    [JSON.stringify({ reason: 'face_verification_required', sessionDurationSeconds }), attendanceId]
  );
}

// Reopens a session after verification if the employee is still in and the event is running.
async function resumeSessionAfterVerification(attendanceId, latitude, longitude) {
  // Row lock prevents two concurrent verifications from opening two sessions.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM attendance WHERE id = ? FOR UPDATE', [attendanceId]);
    const [rows] = await conn.query(
      `SELECT a.id, a.employee_id, a.time_out, e.end_datetime,
              (SELECT COUNT(*) FROM attendance_sessions s WHERE s.attendance_id = a.id AND s.time_out IS NULL) AS open_sessions
       FROM attendance a LEFT JOIN events e ON a.event_id = e.id
       WHERE a.id = ?`,
      [attendanceId]
    );
    const record = rows[0];
    if (!record || record.time_out || Number(record.open_sessions) > 0
        || (record.end_datetime && new Date(record.end_datetime) <= new Date())) {
      await conn.commit();
      return false;
    }
    const [sessionResult] = await conn.query(
      `INSERT INTO attendance_sessions (attendance_id, employee_id, time_in, in_latitude, in_longitude)
       VALUES (?, ?, NOW(), ?, ?)`,
      [attendanceId, record.employee_id, latitude || null, longitude || null]
    );
    await conn.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'duration_resumed', ?)`,
      [attendanceId, record.employee_id, JSON.stringify({ session_id: sessionResult.insertId })]
    );
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Logs a geo_anomalies row, flags the record, pauses its clock and notifies the employee.
async function flagAttendanceForVerification({ attendanceId, employeeId, eventId, deviceUid, latitude, longitude, details }) {
  // Only the first of two concurrent flags logs and notifies.
  const [flagged] = await pool.query(
    'UPDATE attendance SET requires_face_verification = 1, verification_status = ? WHERE id = ? AND COALESCE(requires_face_verification, 0) = 0',
    ['Pending', attendanceId]
  );
  if (flagged.affectedRows === 0) return;

  await pool.query(
    `INSERT INTO geo_anomalies (attendance_id, employee_id, event_id, device_uid, anomaly_type, details, latitude, longitude)
     VALUES (?, ?, ?, ?, 'duplicate_geolocation', ?, ?, ?)`,
    [attendanceId, employeeId, eventId, deviceUid || null, details, latitude, longitude]
  );

  await pauseOpenSession(attendanceId);
  realtime.notifyEmployee(employeeId, 'attendance');

  const [[event]] = await pool.query('SELECT title FROM events WHERE id = ?', [eventId]);
  const eventPart = event?.title ? ` at "${event.title}"` : '';

  await pool.query(
    `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Face Verification Required', ?, 'face_verification_required')`,
    [employeeId, `Your phone reported the same location as another employee's phone${eventPart}. Open the app and complete face verification before the event ends, or your attendance will not be recorded.`]
  );

  await notifyAdmins({
    type: 'geo_anomaly', severity: 'warning', targetView: 'geofence', employeeId,
    title: 'Possible proxy attendance',
    message: `${await employeeLabel(employeeId)}'s phone was at the same spot as another employee's phone${eventPart}. They were asked to complete face verification.`
  });
}

// Geo-anomaly detection: flags both records when two employees' phones stay
// together (see colocatedRecords). Verified records are re-checked after
// anomalyRecheckSeconds.
// attendanceId -> { eventId, employeeId, points: [{ lat, lng, accuracy, at }] }
const recentPositions = new Map();
let recentPositionsSweptAt = 0;

// How long readings are kept: enough to cover a full sustained run.
function trailKeepMs() {
  const a = config.attendance;
  return (a.anomalySustainSeconds + a.anomalyWindowSeconds + a.anomalyPairSeconds) * 1000;
}

function rememberPosition({ attendanceId, eventId, employeeId, latitude, longitude, accuracy }) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!attendanceId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const acc = Number(accuracy);
  const now = Date.now();
  const cutoff = now - trailKeepMs();
  const entry = recentPositions.get(String(attendanceId)) || { eventId, employeeId, points: [] };
  entry.points = entry.points.filter((p) => p.at >= cutoff);
  entry.points.push({ lat, lng, accuracy: Number.isFinite(acc) && acc > 0 ? acc : null, at: now });
  recentPositions.set(String(attendanceId), entry);
  if (now - recentPositionsSweptAt > 10000) {
    recentPositionsSweptAt = now;
    for (const [id, e] of recentPositions) {
      if (!e.points.some((p) => p.at >= cutoff)) recentPositions.delete(id);
    }
  }
}

// A reading too coarse to tell two phones apart says nothing either way.
// (Unknown accuracy is taken at face value.)
function preciseEnough(p) {
  return p.accuracy == null || p.accuracy <= config.attendance.anomalyMaxAccuracyMeters;
}

// Latest unbroken run of paired readings within anomalyDistanceMeters, or null.
function togetherRun(mine, theirs, cutoff) {
  const pairMs = config.attendance.anomalyPairSeconds * 1000;
  const maxMeters = config.attendance.anomalyDistanceMeters;
  const others = theirs.filter((q) => q.at >= cutoff && preciseEnough(q));
  let run = null;
  let j = 0;
  for (const p of mine) {
    if (p.at < cutoff || !preciseEnough(p)) continue;
    while (j + 1 < others.length && others[j + 1].at <= p.at) j += 1;
    let q = null;
    for (const c of [others[j], others[j + 1]]) {
      if (c && Math.abs(c.at - p.at) <= pairMs && (!q || Math.abs(c.at - p.at) < Math.abs(q.at - p.at))) q = c;
    }
    if (!q) continue;
    if (geofenceService.distanceMeters(p.lat, p.lng, q.lat, q.lng) > maxMeters) {
      run = null;
      continue;
    }
    if (!run) run = { count: 0, firstAt: Math.min(p.at, q.at) };
    run.count += 1;
    run.lastAt = Math.max(p.at, q.at);
    run.other = q;
  }
  return run;
}

// attendanceId -> { lat, lng } of other records whose phone stayed with this one.
function colocatedRecords(attendanceId) {
  const matches = new Map();
  const self = recentPositions.get(String(attendanceId));
  if (!self) return matches;
  const a = config.attendance;
  const now = Date.now();
  const cutoff = now - trailKeepMs();
  for (const [id, e] of recentPositions) {
    if (id === String(attendanceId) || String(e.eventId) !== String(self.eventId) || String(e.employeeId) === String(self.employeeId)) continue;
    const run = togetherRun(self.points, e.points, cutoff);
    if (run &&
        run.count >= a.anomalyMinMatches &&
        run.lastAt - run.firstAt >= a.anomalySustainSeconds * 1000 &&
        now - run.lastAt <= a.anomalyWindowSeconds * 1000) {
      matches.set(id, { lat: run.other.lat, lng: run.other.lng });
    }
  }
  return matches;
}

// Returns whether THIS record currently requires face verification.
async function detectGeoAnomaly({ attendanceId, employeeId, eventId, deviceUid, latitude, longitude, accuracy }) {
  rememberPosition({ attendanceId, eventId, employeeId, latitude, longitude, accuracy });

  // Ages computed in SQL so they're timezone-independent.
  const [selfRows] = await pool.query(
    'SELECT requires_face_verification, TIMESTAMPDIFF(SECOND, face_verified_at, NOW()) AS verified_ago_s FROM attendance WHERE id = ?',
    [attendanceId]
  );
  const self = selfRows[0];
  if (!self) return false;
  if (self.requires_face_verification) return true;

  const recheckSeconds = config.attendance.anomalyRecheckSeconds;
  const recentlyVerified = (row) => row.verified_ago_s != null && Number(row.verified_ago_s) < recheckSeconds;
  if (recentlyVerified(self)) return false;

  const matches = colocatedRecords(attendanceId);
  if (!matches.size) return false;
  // Still-open records only (a phone that timed out isn't "here" any more).
  const [candidates] = await pool.query(
    `SELECT a.id, a.employee_id, a.requires_face_verification,
            TIMESTAMPDIFF(SECOND, a.face_verified_at, NOW()) AS verified_ago_s,
            md.device_uid
     FROM attendance a
     LEFT JOIN mobile_devices md ON a.device_id = md.id
     WHERE a.id IN (?) AND a.event_id = ? AND a.employee_id != ? AND a.time_out IS NULL`,
    [[...matches.keys()].map(Number), eventId, employeeId]
  );
  const rows = candidates.map((c) => {
    const seen = matches.get(String(c.id));
    return { ...c, cur_lat: seen.lat, cur_lng: seen.lng };
  });
  if (!rows.length) return false;

  const first = rows[0];
  await flagAttendanceForVerification({
    attendanceId,
    employeeId,
    eventId,
    deviceUid,
    latitude,
    longitude,
    details: `Same location as employee #${first.employee_id}` +
      (first.device_uid && first.device_uid !== deviceUid ? ` (device: ${first.device_uid})` : '')
  });

  for (const other of rows) {
    if (Number(other.requires_face_verification)) continue;
    // Just passed verification -- it gets its own 30 seconds first.
    if (recentlyVerified(other)) continue;
    await flagAttendanceForVerification({
      attendanceId: other.id,
      employeeId: other.employee_id,
      eventId,
      deviceUid: other.device_uid,
      latitude: Number(other.cur_lat),
      longitude: Number(other.cur_lng),
      details: `Same location as employee #${employeeId}` +
        (deviceUid && deviceUid !== other.device_uid ? ` (device: ${deviceUid})` : '')
    });
  }

  return true;
}

// The end-of-event presence rule as a whole percentage, e.g. 80.
function presenceRulePercent() {
  return Math.round(config.attendance.minAttendanceRatioForPresence * 100);
}

// attendance_score: Present = 1, Late = 0.5, over all recorded days.
async function recalculateAttendanceScore(employeeId) {
  const [rows] = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN attendance_status = 'Present' THEN 1 ELSE 0 END) AS present_count,
       SUM(CASE WHEN attendance_status = 'Late' THEN 1 ELSE 0 END) AS late_count
     FROM attendance WHERE employee_id = ?`,
    [employeeId]
  );
  const { total, present_count, late_count } = rows[0];
  if (!total) return;
  const score = ((Number(present_count) + Number(late_count) * 0.5) / total) * 100;
  await pool.query('UPDATE employees SET attendance_score = ? WHERE id = ?', [score.toFixed(2), employeeId]);
}

// rating_points: every 5 attended (Present/Late) = +1, each Absent = -1.
async function recalculateRatingPoints(employeeId) {
  const [rows] = await pool.query(
    `SELECT
       SUM(CASE WHEN attendance_status IN ('Present','Late') THEN 1 ELSE 0 END) AS attended_count,
       SUM(CASE WHEN attendance_status = 'Absent' THEN 1 ELSE 0 END) AS absent_count
     FROM attendance WHERE employee_id = ?`,
    [employeeId]
  );
  const attended = Number(rows[0].attended_count) || 0;
  const absent = Number(rows[0].absent_count) || 0;
  const points = Math.floor(attended / 5) - absent;
  await pool.query('UPDATE employees SET rating_points = ? WHERE id = ?', [points, employeeId]);
}

// Call after any insert/update/delete of an attendance row.
async function recalculateAllRatings(employeeId) {
  await recalculateAttendanceScore(employeeId);
  await recalculateRatingPoints(employeeId);
}

// Adds total duration, open session start and session count to attendance SELECTs.
const ATTENDANCE_DURATION_SUBQUERIES = `,
       (SELECT s.time_in FROM attendance_sessions s
         WHERE s.attendance_id = a.id AND s.time_out IS NULL
         ORDER BY s.time_in DESC LIMIT 1) AS open_session_time_in,
       (SELECT COUNT(*) FROM attendance_sessions s WHERE s.attendance_id = a.id) AS session_count`;

// Closes sessions still open after their event ended, capped at end_datetime.
async function closeSessionsForEndedEvents() {
  const [staleRows] = await pool.query(
    `SELECT a.id, a.employee_id, a.total_duration_seconds, e.end_datetime
     FROM attendance a
     JOIN events e ON a.event_id = e.id
     WHERE a.time_out IS NULL AND e.end_datetime < NOW()`
  );
  for (const record of staleRows) {
    const [openSessionRows] = await pool.query(
      'SELECT * FROM attendance_sessions WHERE attendance_id = ? AND time_out IS NULL ORDER BY time_in ASC LIMIT 1',
      [record.id]
    );
    const openSession = openSessionRows[0];

    let sessionDurationSeconds = 0;
    if (openSession) {
      await pool.query(
        `UPDATE attendance_sessions
         SET time_out = ?, duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, time_in, ?)),
             auto_ended = 1
         WHERE id = ?`,
        [record.end_datetime, record.end_datetime, openSession.id]
      );
      const [[updatedSession]] = await pool.query('SELECT duration_seconds FROM attendance_sessions WHERE id = ?', [openSession.id]);
      sessionDurationSeconds = updatedSession ? updatedSession.duration_seconds : 0;
    }

    const totalDurationSeconds = (record.total_duration_seconds || 0) + sessionDurationSeconds;
    const workHours = (totalDurationSeconds / 3600).toFixed(2);

    await pool.query(
      `UPDATE attendance SET time_out = ?, total_duration_seconds = ?, work_hours = ?, auto_ended = 1 WHERE id = ?`,
      [record.end_datetime, totalDurationSeconds, workHours, record.id]
    );
    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'auto_time_out', ?)`,
      [record.id, record.employee_id, JSON.stringify({ reason: 'event_ended', sessionDurationSeconds, totalDurationSeconds })]
    );
  }
}

// Final status for ended events: GPS rows inside < minAttendanceRatioForPresence
// become Absent. Kiosk rows and admin-finalized rows are left as is.
async function finalizeEndedEventStatuses() {
  const [rows] = await pool.query(
    `SELECT a.id, a.employee_id, a.attendance_status, a.total_duration_seconds, a.verification_method,
            e.start_datetime, e.end_datetime
     FROM attendance a
     JOIN events e ON a.event_id = e.id
     WHERE a.status_finalized = 0 AND a.time_out IS NOT NULL AND e.end_datetime < NOW()`
  );

  for (const record of rows) {
    let finalStatus = record.attendance_status;
    let attendedRatio = null;
    if (record.verification_method === 'mobile_gps' && ['Present', 'Late'].includes(record.attendance_status)) {
      const eventDurationSeconds = Math.max(1, (new Date(record.end_datetime) - new Date(record.start_datetime)) / 1000);
      attendedRatio = (record.total_duration_seconds || 0) / eventDurationSeconds;
      if (attendedRatio < config.attendance.minAttendanceRatioForPresence) finalStatus = 'Absent';
    }

    await pool.query(
      'UPDATE attendance SET attendance_status = ?, status_finalized = 1 WHERE id = ?',
      [finalStatus, record.id]
    );
    realtime.notifyEmployee(record.employee_id, 'attendance');
    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'status_finalized', ?)`,
      [record.id, record.employee_id, JSON.stringify({
        attendedRatio: attendedRatio === null ? null : Number(attendedRatio.toFixed(3)),
        requiredRatio: config.attendance.minAttendanceRatioForPresence,
        previousStatus: record.attendance_status, finalStatus
      })]
    );
    if (finalStatus !== record.attendance_status) {
      await recalculateAllRatings(record.employee_id);
    }
  }
}

// Closes sessions left open past their event's end, then settles every
// ended event's final statuses. Runs before any attendance/report/rating read.
async function settleEndedEvents() {
  await closeSessionsForEndedEvents();
  await finalizeEndedEventStatuses();
  await rejectUnverifiedFlaggedAttendance();
  await expireEndedEventAnomalies();
}

// Resolves anomaly alerts of ended or deleted events (also run every 30 s).
async function expireEndedEventAnomalies() {
  const [result] = await pool.query(
    `UPDATE geo_anomalies ga
     LEFT JOIN events ev ON ga.event_id = ev.id
     SET ga.resolved = 1, ga.resolved_at = NOW()
     WHERE ga.resolved = 0 AND (ev.id IS NULL OR ev.end_datetime < NOW())`
  );
  if (result.affectedRows) realtime.broadcastNow('attendance');
  return result.affectedRows;
}

// Shows Ongoing until the event ends (needs `events ev` joined).
const DISPLAY_STATUS_SQL = "CASE WHEN ev.end_datetime >= NOW() THEN 'Ongoing' ELSE a.attendance_status END";

// Flagged records still unverified when the event ends become Absent / Rejected.
async function rejectUnverifiedFlaggedAttendance() {
  const [rows] = await pool.query(
    `SELECT a.id, a.employee_id, a.attendance_status
     FROM attendance a
     JOIN events e ON a.event_id = e.id
     WHERE a.requires_face_verification = 1 AND a.verification_status = 'Pending' AND e.end_datetime < NOW()`
  );
  for (const record of rows) {
    await pool.query(
      `UPDATE attendance SET attendance_status = 'Absent', verification_status = 'Rejected' WHERE id = ?`,
      [record.id]
    );
    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'face_verification_expired', ?)`,
      [record.id, record.employee_id, JSON.stringify({ reason: 'event_ended_unverified', previousStatus: record.attendance_status })]
    );
    await pool.query(
      `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Attendance Not Recorded', ?, 'face_verification_required')`,
      [record.employee_id, 'Your attendance was not recorded because the required face verification was not completed before the event ended.']
    );
    await notifyAdmins({
      type: 'face_verification_expired', severity: 'danger', targetView: 'attendance', employeeId: record.employee_id, dedupe: false,
      title: 'Attendance rejected',
      message: `${await employeeLabel(record.employee_id)} was marked Absent: the required face verification wasn't completed before the event ended.`
    });
    await recalculateAllRatings(record.employee_id);
  }
}

// GET /api/attendance/my-history  (employee JWT required — used by the mobile app)
async function getMyHistory(req, res, next) {
  try {
    await settleEndedEvents();
    const [rows] = await pool.query(
      `SELECT a.*, ${DISPLAY_STATUS_SQL} AS attendance_status, ev.title AS event_title, ev.venue AS event_venue,
              ev.start_datetime AS event_start, ev.end_datetime AS event_end${ATTENDANCE_DURATION_SUBQUERIES} FROM attendance a
       LEFT JOIN events ev ON a.event_id = ev.id
       WHERE a.employee_id = ?
       ORDER BY a.attendance_date DESC, a.time_in DESC
       LIMIT 200`,
      [req.employee.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance/:id/sessions/admin
async function getSessionsAdmin(req, res, next) {
  try {
    const [attendanceRows] = await pool.query('SELECT id FROM attendance WHERE id = ?', [req.params.id]);
    if (!attendanceRows[0]) return res.status(404).json({ success: false, message: 'Attendance record not found.' });

    const [rows] = await pool.query(
      'SELECT * FROM attendance_sessions WHERE attendance_id = ? ORDER BY time_in ASC',
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance?department=&date=&status=
async function getAttendance(req, res, next) {
  try {
    await settleEndedEvents();
    const { department = 'all', date, status = 'all', event_id } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (department !== 'all') {
      where += ' AND d.name = ?';
      params.push(department);
    }
    if (date) {
      where += ' AND a.attendance_date = ?';
      params.push(date);
    }
    if (status !== 'all') {
      where += ` AND ${DISPLAY_STATUS_SQL} = ?`;
      params.push(status);
    }
    if (event_id) {
      where += ' AND a.event_id = ?';
      params.push(event_id);
    }

    const [rows] = await pool.query(
      `SELECT a.*, ${DISPLAY_STATUS_SQL} AS attendance_status, e.full_name, e.employee_code, d.name AS department_name, ev.title AS event_title,
              ev.start_datetime AS event_start, ev.end_datetime AS event_end,
              ${presenceRulePercent()} AS presence_required_percent${ATTENDANCE_DURATION_SUBQUERIES}
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       JOIN departments d ON e.department_id = d.id
       LEFT JOIN events ev ON a.event_id = ev.id
       ${where}
       ORDER BY a.attendance_date DESC, a.time_in DESC
       LIMIT 500`,
      params
    );

    if (event_id && ['all', 'Absent', 'Ongoing'].includes(status)) {
      const absentRows = await absentRowsForEvent(event_id, department);
      rows.push(...absentRows.filter((r) => status === 'all' || r.attendance_status === status));
    }

    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// Placeholder Absent rows for expected employees with no record (Ongoing until the event ends).
async function absentRowsForEvent(eventId, department) {
  const [[ev]] = await pool.query(
    'SELECT id, title, department_id, start_datetime, end_datetime FROM events WHERE id = ?',
    [eventId]
  );
  if (!ev || new Date(ev.start_datetime) > new Date()) return [];

  let where = `WHERE e.is_approved = 1
    AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.event_id = ? AND a.employee_id = e.id)`;
  const params = [ev.id];
  if (department !== 'all') {
    where += ' AND d.name = ?';
    params.push(department);
  }
  const [[candidates], audiences] = await Promise.all([
    pool.query(
      `SELECT e.id, e.department_id, e.remark, e.id AS employee_id, e.full_name, e.employee_code, d.name AS department_name
       FROM employees e
       JOIN departments d ON e.department_id = d.id
       ${where}
       ORDER BY e.full_name`,
      params
    ),
    eventAudience.loadAudiences([ev.id])
  ]);
  const employees = candidates
    .filter((emp) => eventAudience.isExpected(emp, ev, audiences.get(ev.id)))
    .map(({ id, department_id, remark, ...emp }) => emp);
  const eventDate = new Date(ev.start_datetime);
  const attendanceDate = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}-${String(eventDate.getDate()).padStart(2, '0')}`;
  return employees.map((emp) => ({
    ...emp,
    id: null,
    is_placeholder: true,
    event_id: ev.id,
    event_title: ev.title,
    attendance_date: attendanceDate,
    attendance_status: new Date(ev.end_datetime) >= new Date() ? 'Ongoing' : 'Absent',
    time_in: null,
    time_out: null,
    latitude: null,
    longitude: null,
    session_count: 0
  }));
}

// POST /api/attendance/submit
// Checks: employee/device, GPS accuracy, schedule, geofence, then opens or continues a session.
async function submitAttendance(req, res, next) {
  try {
    const { employee_id, device_uid, event_id, latitude, longitude, accuracy, ocr_record_id, mocked } = req.body;

    if (!employee_id || !event_id || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: 'employee_id, event_id, latitude, and longitude are required.' });
    }
    // An employee can only record their OWN attendance, from their own
    // registered device (both apps always send device_uid).
    if (Number(employee_id) !== Number(req.employee.id)) {
      return res.status(403).json({ success: false, message: 'You can only record your own attendance.' });
    }
    if (!device_uid) {
      return res.status(400).json({ success: false, message: 'device_uid is required.' });
    }
    // Android marks readings from a mock-location provider (Fake GPS and
    // similar apps); the mobile app forwards that flag.
    if (isMockedLocation(mocked)) {
      await pool.query(
        `INSERT INTO attendance_logs (employee_id, action, details) VALUES (?, 'attendance_rejected', ?)`,
        [employee_id, JSON.stringify({ reason: 'mock_location', event_id, latitude, longitude })]
      );
      return res.status(403).json({
        success: false,
        code: 'MOCK_LOCATION',
        message: 'A fake/mock GPS location was detected. Turn off any location-spoofing app and try again.'
      });
    }

    // Every lookup the checks below need, fetched together: the database is
    // remote, so each sequential round trip delays the time-in.
    const now = new Date();
    const today = localDate(now);
    const [[employeeExists], [deviceRows], [eventRows], [geofenceRows], [eventPointRows], [existingRows], audiences] = await Promise.all([
      pool.query('SELECT id, department_id FROM employees WHERE id = ?', [employee_id]),
      pool.query('SELECT * FROM mobile_devices WHERE device_uid = ? AND employee_id = ?', [device_uid, employee_id]),
      pool.query('SELECT * FROM events WHERE id = ?', [event_id]),
      pool.query('SELECT * FROM geofences WHERE event_id = ? AND is_active = 1', [event_id]),
      pool.query(
        `SELECT gp.geofence_id, gp.lat, gp.lng FROM geofence_points gp
         JOIN geofences g ON g.id = gp.geofence_id
         WHERE g.event_id = ? AND g.is_active = 1 ORDER BY gp.point_order`,
        [event_id]
      ),
      pool.query(
        'SELECT * FROM attendance WHERE employee_id = ? AND attendance_date = ? AND event_id = ?',
        [employee_id, today, event_id]
      ),
      eventAudience.loadAudiences([event_id])
    ]);

    // Device cached a deleted employee_id.
    if (!employeeExists[0]) {
      return res.status(404).json({
        success: false,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Your account could not be found. Please sign out and sign in again.'
      });
    }

    // 1. Device authorization
    const device = deviceRows[0];
    if (!device) {
      await notifyAdmins({
        type: 'unregistered_device_attendance', severity: 'danger', targetView: 'mobile-app', employeeId: employee_id,
        title: 'Attendance from an unregistered device',
        message: `${await employeeLabel(employee_id)} tried to record attendance from a device that isn't registered to them.`
      });
      return res.status(403).json({ success: false, message: 'This device is not registered to this employee.' });
    }
    if (device.status === 'blacklisted' || device.status === 'rejected') {
      await notifyAdmins({
        type: 'blocked_device_attendance', severity: 'danger', targetView: 'mobile-app', employeeId: employee_id,
        title: 'Attendance from a blocked device',
        message: `${await employeeLabel(employee_id)} tried to record attendance from a ${device.status} device (${deviceLabel(device)}).`
      });
      return res.status(403).json({ success: false, message: 'This device is not authorized for attendance.' });
    }
    if (device.status === 'pending') {
      return res.status(403).json({ success: false, message: 'This device is pending admin approval.' });
    }

    // 2. GPS accuracy
    if (accuracy !== undefined && accuracy > config.attendance.maxAccuracyMeters) {
      return res.status(400).json({ success: false, message: `GPS accuracy too low (${accuracy}m). Move to an open area and try again.` });
    }

    // 3. Event schedule
    const event = eventRows[0];
    if (!event) return res.status(404).json({ success: false, message: 'Event not found.' });

    if (now < new Date(event.start_datetime) || now > new Date(event.end_datetime)) {
      return res.status(400).json({ success: false, message: 'Attendance is only allowed during the scheduled event window.' });
    }
    // Limited to chosen offices/employees on the Geo-Fences page. A record
    // already started before the admin changed the list is left to continue.
    if (!existingRows[0] && !eventAudience.inAudience(employeeExists[0], event, audiences.get(event.id))) {
      return res.status(403).json({
        success: false,
        code: 'NOT_AN_ATTENDEE',
        message: "You aren't on the attendee list for this event, so there's no need to record attendance."
      });
    }

    // 4. Geofence containment
    const geofence = geofenceRows[0];
    if (!geofence) return res.status(404).json({ success: false, message: 'No active geofence configured for this event.' });
    if (geofenceRows.length > 1) {
      // Duplicate geofences for one event can cause inside/outside mismatches.
      console.warn(`[geofence check] event_id ${event_id} has ${geofenceRows.length} active geofences — using id ${geofence.id}. Duplicate geofences can cause client/server mismatches.`);
    }

    let points = [];
    if (geofence.shape_type !== 'circle') {
      // DECIMAL columns come back as strings.
      points = eventPointRows
        .filter((p) => Number(p.geofence_id) === Number(geofence.id))
        .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
    }

    const { inside, distanceMeters } = geofenceService.isInsideGeofence(
      parseFloat(latitude),
      parseFloat(longitude),
      { ...geofence, points },
      edgeTolerance(accuracy)
    );

    console.log('[geofence check]', {
      event_id,
      geofence_id: geofence.id,
      shape_type: geofence.shape_type,
      submitted: { lat: parseFloat(latitude), lng: parseFloat(longitude) },
      points,
      inside,
      distanceMeters
    });

    if (!inside) {
      await pool.query(
        `INSERT INTO attendance_logs (employee_id, action, details) VALUES (?, 'attendance_rejected', ?)`,
        [employee_id, JSON.stringify({ reason: 'outside_geofence', distanceMeters })]
      );
      return res.status(403).json({
        success: false,
        message: `You are outside the geofence boundary${distanceMeters ? ` (${distanceMeters}m away)` : ''}.`
      });
    }

    // One attendance row per employee/event/day; each time-in/out is an attendance_sessions row.
    const existing = existingRows[0];

    const lateGraceMs = config.attendance.lateGraceMinutes * 60 * 1000;
    const lateThreshold = new Date(new Date(event.start_datetime).getTime() + lateGraceMs);
    const isLate = now > lateThreshold;
    const lateMinutes = isLate ? Math.round((now - new Date(event.start_datetime)) / 60000) : 0;

    if (existing) {
      // Already timed in; time-out comes from heartbeat().
      if (!existing.time_out) {
        return res.status(409).json({ success: false, message: 'Attendance session already in progress for this event.' });
      }

      // Awaiting face verification: timed in, but no session until verified.
      if (existing.requires_face_verification) {
        await pool.query(
          `UPDATE attendance SET time_out = NULL, outside_streak = 0, latitude = ?, longitude = ?, last_lat = ?, last_lng = ?, accuracy_meters = ? WHERE id = ?`,
          [latitude, longitude, latitude, longitude, accuracy || null, existing.id]
        );
        realtime.broadcastNow('attendance-status');
        res.status(200).json({
          success: true,
          message: 'Welcome back — complete face verification to resume your time.',
          data: { id: existing.id, action: 're_time_in', status: existing.attendance_status, requiresFaceVerification: true }
        });
        afterResponse('re-entry time-in log', () => pool.query(
          `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'time_in', ?)`,
          [existing.id, employee_id, JSON.stringify({ latitude, longitude, re_entry: true, paused_for_face_verification: true })]
        ));
        return;
      }

      // Re-entry: open a new session and reopen the parent row.
      const [[sessionResult]] = await Promise.all([
        pool.query(
          `INSERT INTO attendance_sessions (attendance_id, employee_id, time_in, in_latitude, in_longitude)
           VALUES (?, ?, NOW(), ?, ?)`,
          [existing.id, employee_id, latitude, longitude]
        ),
        pool.query(
          `UPDATE attendance SET time_out = NULL, outside_streak = 0, latitude = ?, longitude = ?, last_lat = ?, last_lng = ?, accuracy_meters = ? WHERE id = ?`,
          [latitude, longitude, latitude, longitude, accuracy || null, existing.id]
        )
      ]);
      // Admin attendance views show the re-entry right away.
      realtime.broadcastNow('attendance-status');

      const anomalyDetectedAgain = await detectGeoAnomaly({
        attendanceId: existing.id,
        employeeId: employee_id,
        eventId: event_id,
        deviceUid: device_uid,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        accuracy
      });

      res.status(200).json({
        success: true,
        message: 'Welcome back — time-in recorded again.',
        data: { id: existing.id, sessionId: sessionResult.insertId, action: 'time_in', status: existing.attendance_status, requiresFaceVerification: anomalyDetectedAgain }
      });
      // The time-in itself is saved; the log and the notification don't hold up the reply.
      afterResponse('re-entry time-in log', () => Promise.all([
        pool.query(
          `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'time_in', ?)`,
          [existing.id, employee_id, JSON.stringify({ latitude, longitude, session_id: sessionResult.insertId, re_entry: true })]
        ),
        !anomalyDetectedAgain && pool.query(
          `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Time-In Recorded', ?, 'attendance_success')`,
          [employee_id, `You re-entered "${event.title}" and were automatically timed in again.`]
        )
      ]));
      return;
    }

    // First time-in of the day for this event.
    const [insertResult] = await pool.query(
      `INSERT INTO attendance
        (employee_id, event_id, geofence_id, device_id, ocr_record_id, attendance_date, time_in,
         latitude, longitude, accuracy_meters, attendance_status, verification_status, late_minutes)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 'Verified', ?)`,
      [
        employee_id,
        event_id,
        geofence.id,
        device ? device.id : null,
        ocr_record_id || null,
        today,
        latitude,
        longitude,
        accuracy || null,
        isLate ? 'Late' : 'Present',
        lateMinutes
      ]
    );

    await pool.query(
      `INSERT INTO attendance_sessions (attendance_id, employee_id, time_in, in_latitude, in_longitude)
       VALUES (?, ?, NOW(), ?, ?)`,
      [insertResult.insertId, employee_id, latitude, longitude]
    );
    // Admin attendance views show the time-in right away.
    realtime.broadcastNow('attendance-status');

    const anomalyDetected = await detectGeoAnomaly({
      attendanceId: insertResult.insertId,
      employeeId: employee_id,
      eventId: event_id,
      deviceUid: device_uid,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      accuracy
    });

    res.status(201).json({
      success: true,
      message: anomalyDetected
        ? 'Attendance recorded, but unusual location activity was detected. Please complete face verification in the app.'
        : `Time-in recorded${isLate ? ' (late)' : ''}. Your status shows as Ongoing until the event ends.`,
      data: { id: insertResult.insertId, action: 'time_in', status: isLate ? 'Late' : 'Present', lateMinutes, requiresFaceVerification: anomalyDetected }
    });
    // The time-in itself is saved; the log, notification and rating
    // recalculation don't hold up the reply.
    afterResponse('time-in follow-up', () => Promise.all([
      pool.query(
        `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'time_in', ?)`,
        [insertResult.insertId, employee_id, JSON.stringify({ latitude, longitude, isLate })]
      ),
      !anomalyDetected && pool.query(
        `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Attendance Recorded', ?, 'attendance_success')`,
        [employee_id, `You were timed in for "${event.title}"${isLate ? ' (late)' : ''}. Stay inside the event area for at least ${presenceRulePercent()}% of the event to be counted; your status shows as Ongoing until it ends.`]
      ),
      recalculateAllRatings(employee_id)
    ]));
  } catch (err) {
    next(err);
  }
}

// Admin kiosk attendance after a successful OCR/face match (called from
// ocrController.verifyId and faceController.verifyFace). No geofence and no
// sessions: time_in = time_out = now, Present or Late by the grace window.
// An existing record for the same event/day is returned unchanged.
async function recordVerificationAttendance({ employeeId, eventId, method, ocrRecordId, faceRecordId, adminId }) {
  if (!['ocr', 'face'].includes(method)) {
    throw new Error(`recordVerificationAttendance: unsupported method "${method}"`);
  }

  const [eventRows] = await pool.query('SELECT * FROM events WHERE id = ?', [eventId]);
  const event = eventRows[0];
  if (!event) return { success: false, status: 404, message: 'Event not found.' };

  const now = new Date();
  if (now < new Date(event.start_datetime) || now > new Date(event.end_datetime)) {
    return { success: false, status: 400, message: 'This event is not currently active — attendance can only be recorded during its scheduled window.' };
  }

  const today = localDate(now);
  const [existingRows] = await pool.query(
    'SELECT * FROM attendance WHERE employee_id = ? AND attendance_date = ? AND event_id = ?',
    [employeeId, today, eventId]
  );
  const existing = existingRows[0];

  if (existing) {
    // The admin's in-person verification clears a pending geo-anomaly flag.
    if (existing.requires_face_verification) {
      await pool.query(
        `UPDATE attendance SET requires_face_verification = 0, face_verified_at = NOW(), verification_status = 'Verified' WHERE id = ?`,
        [existing.id]
      );
      await pool.query(
        `UPDATE geo_anomalies SET resolved = 1, resolved_by = ?, resolved_at = NOW() WHERE attendance_id = ? AND resolved = 0`,
        [adminId || null, existing.id]
      );
      await pool.query(
        `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'anomaly_resolved', ?)`,
        [existing.id, employeeId, JSON.stringify({ method, adminId: adminId || null })]
      );
      await resumeSessionAfterVerification(existing.id, null, null);
      realtime.notifyEmployee(employeeId, 'attendance');
      return {
        success: true,
        status: 200,
        action: 'anomaly_resolved',
        attendanceId: existing.id,
        status_label: existing.attendance_status
      };
    }
    return {
      success: true,
      status: 200,
      action: 'already_recorded',
      attendanceId: existing.id,
      status_label: existing.attendance_status
    };
  }

  const lateGraceMs = config.attendance.lateGraceMinutes * 60 * 1000;
  const lateThreshold = new Date(new Date(event.start_datetime).getTime() + lateGraceMs);
  const isLate = now > lateThreshold;
  const lateMinutes = isLate ? Math.round((now - new Date(event.start_datetime)) / 60000) : 0;

  const [insertResult] = await pool.query(
    `INSERT INTO attendance
      (employee_id, event_id, ocr_record_id, verification_method, face_record_id, verified_by_admin_id,
       attendance_date, time_in, time_out, attendance_status, verification_status, late_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, 'Verified', ?)`,
    [
      employeeId,
      eventId,
      method === 'ocr' ? (ocrRecordId || null) : null,
      method === 'ocr' ? 'ocr' : 'face',
      method === 'face' ? (faceRecordId || null) : null,
      adminId || null,
      today,
      isLate ? 'Late' : 'Present',
      lateMinutes
    ]
  );

  await pool.query(
    `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'attendance_recorded', ?)`,
    [insertResult.insertId, employeeId, JSON.stringify({ method, ocrRecordId: ocrRecordId || null, faceRecordId: faceRecordId || null, adminId: adminId || null, isLate })]
  );
  await pool.query(
    `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Attendance Recorded', ?, 'attendance_success')`,
    [employeeId, `Your attendance for "${event.title}" was recorded as ${isLate ? 'Late' : 'Present'} via admin-assisted ${method === 'ocr' ? 'ID verification' : 'face verification'}.`]
  );

  await recalculateAllRatings(employeeId);
  realtime.notifyEmployee(employeeId, 'attendance');

  return {
    success: true,
    status: 201,
    action: 'recorded',
    attendanceId: insertResult.insertId,
    status_label: isLate ? 'Late' : 'Present',
    lateMinutes
  };
}

// POST /api/attendance/:id/face-verify (employee JWT)
// Multipart: selfie, video?, latitude, longitude, liveness_verified, liveness_actions
// Clears a geo-anomaly flag only if the selfie matches one of the employee's enrolled faces.
async function faceVerify(req, res, next) {
  try {
    const { id } = req.params;
    const { latitude, longitude } = req.body;

    const [rows] = await pool.query('SELECT * FROM attendance WHERE id = ? AND employee_id = ?', [id, req.employee.id]);
    const record = rows[0];
    if (!record) return res.status(404).json({ success: false, message: 'Attendance record not found.' });
    const selfieFile = req.files?.selfie?.[0];
    const videoFile = req.files?.video?.[0];
    if (!selfieFile) return res.status(400).json({ success: false, message: 'A selfie photo is required.' });

    const selfiePath = `/uploads/selfies/${selfieFile.filename}`;
    const videoPath = videoFile ? `/uploads/face_videos/${videoFile.filename}` : null;
    const livenessActions = typeof req.body.liveness_actions === 'string' ? req.body.liveness_actions.slice(0, 120) : null;
    // Every attempt is saved to face_records (source 'mobile_anomaly').
    const recordAttempt = (result, similarity = null) => pool.query(
      `INSERT INTO face_records (employee_id, image_path, similarity, result, liveness_verified, liveness_actions, source)
       VALUES (?, ?, ?, ?, ?, ?, 'mobile_anomaly')`,
      [req.employee.id, selfiePath, similarity, result,
        req.body.liveness_verified === 'true' || req.body.liveness_verified === true ? 1 : 0, livenessActions]
    );

    // Only accepted while the event is still running.
    if (record.event_id) {
      const [eventRows] = await pool.query('SELECT end_datetime FROM events WHERE id = ?', [record.event_id]);
      if (eventRows[0] && new Date(eventRows[0].end_datetime) <= new Date()) {
        await recordAttempt('expired');
        await settleEndedEvents();
        return res.status(410).json({
          success: false,
          result: 'expired',
          message: 'This event has already ended, so face verification is closed and this attendance was not recorded.'
        });
      }
    }

    // Reject before running the face model if liveness wasn't completed.
    const livenessVerified = req.body.liveness_verified === 'true' || req.body.liveness_verified === true;
    if (!livenessVerified) {
      return res.status(400).json({
        success: false,
        result: 'liveness_failed',
        message: 'Liveness check was not completed. Please retry the selfie verification.'
      });
    }

    let embedding;
    try {
      embedding = await faceService.getEmbedding(selfieFile.path);
    } catch (err) {
      await recordAttempt('no_face_detected');
      return res.status(502).json({
        success: false,
        result: 'no_face_detected',
        message: err.message.includes('No face was detected')
          ? err.message
          : 'Could not process the captured photo. Please retake it.'
      });
    }

    const [faceRows] = await pool.query('SELECT image_path, embedding FROM employee_faces WHERE employee_id = ?', [req.employee.id]);
    if (!faceRows.length) {
      return res.status(409).json({
        success: false,
        result: 'not_enrolled',
        message: 'No enrolled face on file for your account. Please contact an administrator.'
      });
    }
    const candidates = faceRows.map((r) => ({ employeeId: req.employee.id, embedding: JSON.parse(r.embedding) }));
    const match = faceService.findBestMatch(embedding, candidates);

    if (!match) {
      await pool.query(
        `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'face_verify_failed', ?)`,
        [id, req.employee.id, JSON.stringify({ latitude, longitude, reason: 'no_match', selfie_path: selfiePath, video_path: videoPath })]
      );
      await recordAttempt('no_match');
      return res.status(401).json({
        success: false,
        result: 'no_match',
        message: "This photo doesn't match your enrolled face closely enough. Please try again, centered and well-lit."
      });
    }

    // verification_method stays 'mobile_gps' so the record keeps its session durations.
    await pool.query(
      `UPDATE attendance SET selfie_path = ?, selfie_lat = ?, selfie_lng = ?, requires_face_verification = 0,
       face_verified_at = NOW(), verification_status = 'Verified' WHERE id = ?`,
      [selfiePath, latitude || null, longitude || null, id]
    );
    await recordAttempt('matched', Math.max(0, match.similarity) * 100);

    await pool.query(
      `UPDATE geo_anomalies SET resolved = 1, resolved_at = NOW() WHERE attendance_id = ? AND resolved = 0`,
      [id]
    );

    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'face_verified', ?)`,
      [id, req.employee.id, JSON.stringify({ latitude, longitude, similarity: match.similarity, liveness_actions: livenessActions, selfie_path: selfiePath, video_path: videoPath })]
    );

    // The clock was stopped when this record was flagged -- start it again.
    const resumed = await resumeSessionAfterVerification(id, latitude, longitude);
    realtime.notifyEmployee(req.employee.id, 'attendance');

    res.json({
      success: true,
      result: 'matched',
      resumed,
      message: resumed
        ? 'Face verified. Your attendance is confirmed and your time is being recorded again.'
        : 'Face verification submitted. Your attendance is now confirmed.'
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance/anomalies  (admin — powers the Geo-Fence alerts panel)
async function getAnomalies(req, res, next) {
  try {
    const { resolved = '0' } = req.query;
    // Only alerts of running events.
    const [rows] = await pool.query(
      `SELECT ga.*, e.full_name, e.employee_code, ev.title AS event_title
       FROM geo_anomalies ga
       JOIN employees e ON ga.employee_id = e.id
       LEFT JOIN events ev ON ga.event_id = ev.id
       WHERE ga.resolved = ?
         ${resolved === '1' ? '' : 'AND ev.end_datetime >= NOW()'}
       ORDER BY ga.created_at DESC
       LIMIT 100`,
      [resolved === '1' ? 1 : 0]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance/anomaly-rechecks
// Verified records whose phone is still with another employee's, with seconds_left
// until they're flagged again.
async function getAnomalyRechecks(req, res, next) {
  try {
    const recheckSeconds = config.attendance.anomalyRecheckSeconds;
    const maxMeters = config.attendance.anomalyDistanceMeters;
    const [rows] = await pool.query(
      `SELECT a.id, a.employee_id, a.event_id, a.requires_face_verification,
              TIMESTAMPDIFF(SECOND, a.face_verified_at, NOW()) AS verified_ago_s,
              e.full_name, e.employee_code, ev.title AS event_title
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       LEFT JOIN events ev ON a.event_id = ev.id
       WHERE a.time_out IS NULL
         AND a.event_id IN (
           SELECT event_id FROM attendance
           WHERE time_out IS NULL AND face_verified_at >= NOW() - INTERVAL ? SECOND
         )`,
      [recheckSeconds]
    );
    const data = [];
    for (const r of rows) {
      if (Number(r.requires_face_verification)) continue;
      if (r.verified_ago_s == null || Number(r.verified_ago_s) >= recheckSeconds) continue;
      const together = colocatedRecords(r.id);
      if (!together.size) continue;
      const near = rows.find((o) => o.id !== r.id && o.event_id === r.event_id && o.employee_id !== r.employee_id && together.has(String(o.id)));
      if (!near) continue;
      data.push({
        attendance_id: r.id,
        employee_id: r.employee_id,
        full_name: r.full_name,
        employee_code: r.employee_code,
        event_title: r.event_title,
        near_full_name: near.full_name,
        near_employee_code: near.employee_code,
        seconds_left: Math.max(0, recheckSeconds - Number(r.verified_ago_s))
      });
    }
    res.json({ success: true, data, recheckSeconds, distanceMeters: maxMeters });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance/by-event  (folder counts for the "organized by Event" admin UI)
async function getAttendanceByEvent(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT e.id, e.title, e.venue, e.start_datetime, e.end_datetime,
              (SELECT COUNT(*) FROM attendance a WHERE a.event_id = e.id) AS log_count
       FROM events e
       ORDER BY CASE WHEN NOW() BETWEEN e.start_datetime AND e.end_datetime THEN 0
                     WHEN e.start_datetime > NOW() THEN 1
                     ELSE 2 END,
                CASE WHEN e.start_datetime > NOW() THEN e.start_datetime END ASC,
                e.start_datetime DESC`
    );
    const now = new Date();
    const data = rows.map((e) => {
      const start = new Date(e.start_datetime);
      const end = new Date(e.end_datetime);
      let computed_status = 'upcoming';
      if (now >= start && now <= end) computed_status = 'ongoing';
      else if (now > end) computed_status = 'completed';
      return { ...e, computed_status };
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/attendance/:id (admin correction; recalculates ratings)
async function updateAttendance(req, res, next) {
  try {
    const { id } = req.params;
    const { attendance_status } = req.body;
    const validStatuses = ['Present', 'Late', 'Absent', 'Excused'];
    if (!validStatuses.includes(attendance_status)) {
      return res.status(400).json({ success: false, message: `attendance_status must be one of: ${validStatuses.join(', ')}.` });
    }

    const [rows] = await pool.query('SELECT * FROM attendance WHERE id = ?', [id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Attendance record not found.' });

    // status_finalized: the admin's choice stands — the end-of-event presence
    // rule (finalizeEndedEventStatuses) won't override it.
    await pool.query('UPDATE attendance SET attendance_status = ?, status_finalized = 1 WHERE id = ?', [attendance_status, id]);
    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'admin_status_change', ?)`,
      [id, rows[0].employee_id, JSON.stringify({ from: rows[0].attendance_status, to: attendance_status, by: req.admin.id })]
    );

    await recalculateAllRatings(rows[0].employee_id);
    await logAction({ adminId: req.admin.id, action: 'update', module: 'attendance', details: { id, attendance_status }, ip: req.ip });
    realtime.notifyEmployee(rows[0].employee_id, 'attendance');

    res.json({ success: true, message: 'Attendance record updated and ratings recalculated.' });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/attendance/:id  (admin)
async function deleteAttendance(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM attendance WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Attendance record not found.' });

    await pool.query('DELETE FROM attendance WHERE id = ?', [req.params.id]);
    await recalculateAllRatings(rows[0].employee_id);
    await logAction({ adminId: req.admin.id, action: 'delete', module: 'attendance', details: { id: req.params.id }, ip: req.ip });
    realtime.notifyEmployee(rows[0].employee_id, 'attendance');

    res.json({ success: true, message: 'Attendance record deleted and ratings recalculated.' });
  } catch (err) {
    next(err);
  }
}

// POST /api/attendance/:id/heartbeat (employee JWT)
// Body: { latitude, longitude, accuracy?, observed_at?, location_off?, offline_inside_seconds? }
// Closes the session on the first outside reading. observed_at (when the reading
// was taken, possibly while offline) is used as time_out when plausible.
// location_off closes the session immediately.
const HEARTBEAT_OBSERVED_AT_FUTURE_SKEW_MS = 2 * 60 * 1000; // small clock-skew allowance
const HEARTBEAT_OBSERVED_AT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // ignore implausibly stale/garbage values

function resolveHeartbeatEndTime(observedAtRaw, sessionOpenedAt) {
  const now = new Date();
  if (!observedAtRaw) return now;
  const observed = new Date(observedAtRaw);
  if (Number.isNaN(observed.getTime())) return now;
  if (observed.getTime() > now.getTime() + HEARTBEAT_OBSERVED_AT_FUTURE_SKEW_MS) return now; // can't be from the future
  if (now.getTime() - observed.getTime() > HEARTBEAT_OBSERVED_AT_MAX_AGE_MS) return now; // too stale to trust
  if (sessionOpenedAt && observed.getTime() < new Date(sessionOpenedAt).getTime()) return now; // can't end before it started
  return observed;
}

const TIME_OUT_MESSAGES = {
  location_off: 'Your Location was turned off, so your session was automatically timed out. Turn Location back on to continue.',
  left_geofence: 'You left the event area, so your session was automatically timed out.',
  no_signal: 'Your phone stopped reporting its location (Location turned off, or the app stopped), so your session was automatically timed out.'
};

// Closes the open session at endTime and adds its duration to the record's total.
async function autoTimeOut({ record, openSession, endTime, latitude, longitude, outsideStreak, reason }) {
  const id = record.id;
  // The closed session's own duration_seconds is added to the total in the
  // same UPDATE (countedSessionId) instead of being read back first.
  let countedSessionId = null;
  let fallbackSeconds = 0;
  if (openSession) {
    const [closed] = await pool.query(
      `UPDATE attendance_sessions
       SET time_out = ?, duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, time_in, ?)),
           out_latitude = ?, out_longitude = ?, auto_ended = 1
       WHERE id = ? AND time_out IS NULL`,
      [endTime, endTime, latitude, longitude, openSession.id]
    );
    // 0 rows: a concurrent pauseOpenSession already closed this session
    // and added its time to the total -- don't count it twice.
    if (closed.affectedRows !== 0) countedSessionId = openSession.id;
  } else {
    // No open session: expected while paused for face verification (re-read the
    // flag in case it was just set), otherwise fall back to the row's time_in.
    const [[fresh]] = await pool.query('SELECT requires_face_verification FROM attendance WHERE id = ?', [id]);
    if (!fresh?.requires_face_verification) {
      fallbackSeconds = Math.max(0, Math.round((endTime.getTime() - new Date(record.time_in).getTime()) / 1000));
    }
  }

  // Added in SQL rather than overwritten from `record`, so a concurrent
  // pauseOpenSession's addition to the total isn't lost.
  await pool.query(
    `UPDATE attendance SET time_out = ?,
       total_duration_seconds = COALESCE(total_duration_seconds, 0) + ?
         + COALESCE((SELECT duration_seconds FROM attendance_sessions WHERE id = ?), 0),
       work_hours = ROUND(total_duration_seconds / 3600, 2), last_lat = ?, last_lng = ?, last_ping_at = NOW(),
       outside_streak = ?, auto_ended = 1 WHERE id = ?`,
    [endTime, fallbackSeconds, countedSessionId, latitude, longitude, outsideStreak, id]
  );
  // Admin attendance views update now, not after the log/notification
  // writes below or the usual coalescing delay.
  realtime.broadcastNow('attendance-status');
  realtime.notifyEmployee(record.employee_id, 'attendance');

  afterResponse('time-out follow-up', async () => {
    const [[totals]] = await pool.query(
      `SELECT a.total_duration_seconds, s.duration_seconds AS session_seconds
       FROM attendance a LEFT JOIN attendance_sessions s ON s.id = ?
       WHERE a.id = ?`,
      [countedSessionId, id]
    );
    const totalDurationSeconds = Number(totals?.total_duration_seconds) || 0;
    const sessionDurationSeconds = countedSessionId ? Number(totals?.session_seconds) || 0 : fallbackSeconds;
    const workHours = (totalDurationSeconds / 3600).toFixed(2);
    await Promise.all([
      pool.query(
        `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'auto_time_out', ?)`,
        [id, record.employee_id, JSON.stringify({ latitude, longitude, reason, sessionDurationSeconds, totalDurationSeconds, observedAt: endTime.toISOString() })]
      ),
      pool.query(
        `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Time-Out Recorded', ?, 'attendance_auto_end')`,
        [record.employee_id, `${TIME_OUT_MESSAGES[reason] || TIME_OUT_MESSAGES.left_geofence} Total time so far: ${workHours} hour(s).`]
      )
    ]);
  });
}

// Times out sessions with no ping for silentSessionSeconds, at the last ping time.
// Skipped until the server has been up for one silence window.
const serverStartedAt = Date.now();
let sweeping = false;
async function closeSilentSessions() {
  const silentSeconds = config.attendance.silentSessionSeconds;
  if (!(silentSeconds > 0) || sweeping) return;
  if (Date.now() - serverStartedAt < silentSeconds * 1000) return;
  sweeping = true;
  try {
    // Ages are compared in SQL, against the database's own clock, like
    // detectGeoAnomaly does.
    const [rows] = await pool.query(
      `SELECT x.* FROM (
         SELECT a.*,
                GREATEST(COALESCE(a.last_ping_at, a.time_in),
                         COALESCE((SELECT MAX(s.time_in) FROM attendance_sessions s WHERE s.attendance_id = a.id), a.time_in)) AS last_heard_at
         FROM attendance a
         JOIN events e ON e.id = a.event_id
         WHERE a.time_out IS NULL AND a.verification_method = 'mobile_gps' AND e.end_datetime > NOW()
       ) x
       WHERE x.last_heard_at < NOW() - INTERVAL ? SECOND`,
      [silentSeconds]
    );
    for (const record of rows) {
      const [[[still]], [[openSession]]] = await Promise.all([
        pool.query('SELECT time_out, last_ping_at FROM attendance WHERE id = ?', [record.id]),
        pool.query(
          'SELECT * FROM attendance_sessions WHERE attendance_id = ? AND time_out IS NULL ORDER BY time_in DESC LIMIT 1',
          [record.id]
        )
      ]);
      // A ping (or another time-out) may have landed since the scan.
      if (!still || still.time_out || still.last_ping_at !== record.last_ping_at) continue;
      await autoTimeOut({
        record,
        openSession,
        endTime: new Date(record.last_heard_at),
        latitude: record.last_lat ?? record.latitude,
        longitude: record.last_lng ?? record.longitude,
        outsideStreak: record.outside_streak || 0,
        reason: 'no_signal'
      });
      console.log(`[attendance] Timed out attendance #${record.id}: no signal from the phone since ${record.last_heard_at}.`);
    }
  } catch (err) {
    console.error('[attendance] Silent-session sweep failed:', err.message);
  } finally {
    sweeping = false;
  }
}

// Reopens a no_signal time-out when the phone reports it stayed inside the
// whole time it was offline (offline_inside_seconds). Only while the event runs,
// the record isn't flagged, and nothing was recorded since.
const OFFLINE_RESUME_SLACK_SECONDS = 20; // request latency between the server's last ping and the phone's receipt of it
async function resumeAfterOffline(record, claimRaw) {
  const claimSeconds = Number(claimRaw);
  if (!(claimSeconds > 0) || record.requires_face_verification) return null;

  const [[[check]], [[lastLog]], [[lastSession]]] = await Promise.all([
    pool.query(
      `SELECT (NOW() - INTERVAL ? SECOND) <= (a.time_out + INTERVAL ? SECOND) AS covered, e.end_datetime > NOW() AS running
       FROM attendance a JOIN events e ON e.id = a.event_id WHERE a.id = ?`,
      [Math.ceil(claimSeconds), OFFLINE_RESUME_SLACK_SECONDS, record.id]
    ),
    pool.query('SELECT action, details FROM attendance_logs WHERE attendance_id = ? ORDER BY id DESC LIMIT 1', [record.id]),
    pool.query('SELECT * FROM attendance_sessions WHERE attendance_id = ? ORDER BY time_in DESC, id DESC LIMIT 1', [record.id])
  ]);
  if (!check?.covered || !check.running) return null;
  let reason = null;
  try { reason = JSON.parse(lastLog?.details || '{}').reason; } catch (e) { /* not JSON */ }
  if (lastLog?.action !== 'auto_time_out' || reason !== 'no_signal') return null;
  if (!lastSession || !lastSession.auto_ended || lastSession.time_out !== record.time_out) return null;

  const sessionSeconds = Number(lastSession.duration_seconds) || 0;
  const [reopened] = await pool.query(
    `UPDATE attendance SET time_out = NULL,
       total_duration_seconds = GREATEST(0, COALESCE(total_duration_seconds, 0) - ?),
       work_hours = ROUND(total_duration_seconds / 3600, 2), last_ping_at = NOW(), outside_streak = 0
     WHERE id = ? AND time_out = ?`,
    [sessionSeconds, record.id, record.time_out]
  );
  if (!reopened.affectedRows) {
    // Another ping from the same phone may have just reopened it.
    const [[fresh]] = await pool.query('SELECT * FROM attendance WHERE id = ?', [record.id]);
    return fresh && !fresh.time_out ? fresh : null;
  }
  await pool.query(
    `UPDATE attendance_sessions SET time_out = NULL, duration_seconds = NULL, out_latitude = NULL, out_longitude = NULL, auto_ended = 0
     WHERE id = ?`,
    [lastSession.id]
  );
  realtime.broadcastNow('attendance-status');
  realtime.notifyEmployee(record.employee_id, 'attendance');
  console.log(`[attendance] Resumed attendance #${record.id}: the phone was offline but stayed inside (${Math.round(claimSeconds)} s).`);
  afterResponse('offline resume follow-up', () => Promise.all([
    pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'resumed_after_offline', ?)`,
      [record.id, record.employee_id, JSON.stringify({ previousTimeOut: record.time_out, offlineInsideSeconds: Math.round(claimSeconds) })]
    ),
    pool.query(
      `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Attendance Continued', ?, 'attendance_auto_end')`,
      [record.employee_id, 'Your phone lost its internet connection, but it stayed inside the event area, so your attendance kept counting.']
    )
  ]));
  const [[fresh]] = await pool.query('SELECT * FROM attendance WHERE id = ?', [record.id]);
  return fresh;
}

async function heartbeat(req, res, next) {
  try {
    const { id } = req.params;
    const { observed_at, accuracy, mocked } = req.body;
    let { latitude, longitude } = req.body;
    const locationOff = req.body.location_off === true || req.body.location_off === 'true';
    if (!locationOff && (latitude === undefined || longitude === undefined)) {
      return res.status(400).json({ success: false, message: 'latitude and longitude are required.' });
    }

    const [rows] = await pool.query('SELECT * FROM attendance WHERE id = ? AND employee_id = ?', [id, req.employee.id]);
    let record = rows[0];
    if (!record) return res.status(404).json({ success: false, message: 'Attendance record not found.' });
    // Timed out while offline but stayed inside: reopen, then handle this ping normally.
    if (record.time_out) record = (await resumeAfterOffline(record, req.body.offline_inside_seconds)) || record;
    if (locationOff) {
      // The phone may never have had a fix to send -- fall back to the last
      // position the server already has for this session.
      if (latitude == null) latitude = record.last_lat ?? record.latitude;
      if (longitude == null) longitude = record.last_lng ?? record.longitude;
    }
    if (record.time_out) {
      // Already timed out; re-entry goes through submitAttendance().
      return res.json({ success: true, message: 'No session currently open.', data: { ended: true } });
    }

    // Event ended while still inside: close at the event's end time.
    const [[eventRows], [geofenceRows], [pointRows], [openSessionRows]] = await Promise.all([
      pool.query('SELECT end_datetime FROM events WHERE id = ?', [record.event_id]),
      pool.query('SELECT * FROM geofences WHERE id = ?', [record.geofence_id]),
      pool.query('SELECT lat, lng FROM geofence_points WHERE geofence_id = ? ORDER BY point_order', [record.geofence_id]),
      pool.query(
        'SELECT * FROM attendance_sessions WHERE attendance_id = ? AND time_out IS NULL ORDER BY time_in DESC LIMIT 1',
        [id]
      )
    ]);
    if (eventRows[0] && new Date(eventRows[0].end_datetime) <= new Date()) {
      await settleEndedEvents();
      return res.json({ success: true, message: 'Event has ended.', data: { ended: true } });
    }

    const geofence = geofenceRows[0];
    let inside = true;
    if (locationOff) {
      inside = false;
    } else if (geofence) {
      const points = geofence.shape_type !== 'circle'
        ? pointRows.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
        : [];
      ({ inside } = geofenceService.isInsideGeofence(parseFloat(latitude), parseFloat(longitude), { ...geofence, points }, edgeTolerance(accuracy)));
    }
    // Mock locations count as outside.
    if (isMockedLocation(mocked)) inside = false;

    // Debounce inside pings only; outside pings are always handled.
    if (inside && record.last_ping_at && !locationOff) {
      const secondsSinceLast = (Date.now() - new Date(record.last_ping_at).getTime()) / 1000;
      if (secondsSinceLast < config.attendance.heartbeatMinIntervalSeconds) {
        // Too soon for a full check: only update the live position.
        let requiresFaceVerification = !!record.requires_face_verification;
        if (!observed_at && latitude != null && longitude != null) {
          await pool.query('UPDATE attendance SET last_lat = ?, last_lng = ? WHERE id = ?', [latitude, longitude, id]);
          // Still checked for another phone at the same spot, so a match
          // is flagged on this very ping rather than on the next full one.
          const [deviceRows] = record.device_id
            ? await pool.query('SELECT device_uid FROM mobile_devices WHERE id = ?', [record.device_id])
            : [[]];
          requiresFaceVerification = await detectGeoAnomaly({
            attendanceId: record.id,
            employeeId: record.employee_id,
            eventId: record.event_id,
            deviceUid: deviceRows[0]?.device_uid,
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude),
            accuracy
          });
        }
        // `ignored`: last_ping_at wasn't moved, so the app doesn't count this
        // as the server having heard from it (see presenceTrail.js).
        return res.json({ success: true, message: 'Ping ignored (too soon).', data: { ended: false, inside, ignored: true, requiresFaceVerification } });
      }
    }

    const newStreak = inside ? 0 : (record.outside_streak || 0) + 1;
    const shouldAutoEnd = locationOff || newStreak >= config.attendance.autoEndOutsideStreakThreshold;

    if (shouldAutoEnd) {
      const endTime = resolveHeartbeatEndTime(observed_at, openSessionRows[0]?.time_in || record.time_in);
      await autoTimeOut({
        record,
        openSession: openSessionRows[0],
        endTime,
        latitude,
        longitude,
        outsideStreak: newStreak,
        reason: locationOff ? 'location_off' : 'left_geofence'
      });
      // The time-out is saved: the app gets its answer before the
      // log/notification writes autoTimeOut leaves running.
      return res.json({ success: true, data: { ended: true, inside, outsideStreak: newStreak, requiresFaceVerification: !!record.requires_face_verification } });
    } else {
      await pool.query(
        `UPDATE attendance SET last_lat = ?, last_lng = ?, last_ping_at = NOW(), outside_streak = ? WHERE id = ?`,
        [latitude, longitude, newStreak, id]
      );
    }

    // Check for co-located phones on every ping, not just at time-in.
    let requiresFaceVerification = !!record.requires_face_verification;
    if (!shouldAutoEnd && inside) {
      const [deviceRows] = record.device_id
        ? await pool.query('SELECT device_uid FROM mobile_devices WHERE id = ?', [record.device_id])
        : [[]];
      requiresFaceVerification = await detectGeoAnomaly({
        attendanceId: record.id,
        employeeId: record.employee_id,
        eventId: record.event_id,
        deviceUid: deviceRows[0]?.device_uid,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        accuracy
      });
    }

    res.json({ success: true, data: { ended: shouldAutoEnd, inside, outsideStreak: newStreak, requiresFaceVerification } });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAttendance,
  getAttendanceByEvent,
  submitAttendance,
  getMyHistory,
  getSessionsAdmin,
  faceVerify,
  getAnomalies,
  getAnomalyRechecks,
  updateAttendance,
  deleteAttendance,
  heartbeat,
  closeSilentSessions,
  recordVerificationAttendance,
  // Used by reportController/ratingController to settle ended events'
  // attendance before counting it, and to show Ongoing for running events.
  settleEndedEvents,
  expireEndedEventAnomalies,
  DISPLAY_STATUS_SQL
};
