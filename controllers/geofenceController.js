const pool = require('../config/db');
const config = require('../config/config');
const { logAction } = require('../services/auditService');
const pushService = require('../services/pushService');
const eventAudience = require('../services/eventAudience');

function centroidOf(points) {
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + Number(p.lat), lng: acc.lng + Number(p.lng) }), { lat: 0, lng: 0 });
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

// Expands a recurring definition into occurrence dates (ISO weekdays 1=Mon..7=Sun).
function expandRecurrenceDates({ recurrence_type, recurrence_days, start, end, recurrence_end_date }) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const durationMs = endDate - startDate;
  const occurrences = [{ start: startDate, end: endDate }]; // the first occurrence is always the form's own start/end

  if (recurrence_type === 'none' || !recurrence_end_date) return occurrences;

  const untilDate = new Date(`${recurrence_end_date}T23:59:59`);
  const days = (recurrence_days || '')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => d >= 1 && d <= 7);

  if (recurrence_type === 'weekly' && days.length) {
    const cursor = new Date(startDate);
    cursor.setDate(cursor.getDate() + 1); // start scanning the day after the first occurrence
    while (cursor <= untilDate) {
      const isoDay = cursor.getDay() === 0 ? 7 : cursor.getDay();
      if (days.includes(isoDay)) {
        const occStart = new Date(cursor);
        occStart.setHours(startDate.getHours(), startDate.getMinutes(), startDate.getSeconds(), 0);
        const occEnd = new Date(occStart.getTime() + durationMs);
        occurrences.push({ start: occStart, end: occEnd });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return occurrences;
}

// Formats with local fields; toISOString() would shift the time to UTC.
function toMysqlDatetime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 409 message when an occurrence duplicates an event or double-books its venue, else null.
async function findScheduleConflict(conn, { title, venue, occurrences, excludeEventId = null }) {
  const normTitle = String(title || '').trim().toLowerCase();
  const normVenue = String(venue || '').trim().toLowerCase();
  for (const occ of occurrences) {
    const start = toMysqlDatetime(occ.start);
    const end = toMysqlDatetime(occ.end);
    const [rows] = await conn.query(
      `SELECT id, title, venue, start_datetime, end_datetime FROM events
       WHERE start_datetime < ? AND end_datetime > ?
         AND (id <> ? OR ? IS NULL)
         AND (
           (LOWER(TRIM(title)) = ? AND start_datetime = ? AND end_datetime = ?)
           OR (? <> '' AND LOWER(TRIM(venue)) = ?)
         )
       LIMIT 1`,
      [end, start, excludeEventId, excludeEventId, normTitle, start, end, normVenue, normVenue]
    );
    const clash = rows[0];
    if (!clash) continue;
    const when = `${clash.start_datetime.slice(0, 16)} to ${clash.end_datetime.slice(0, 16)}`;
    if (clash.title.trim().toLowerCase() === normTitle && clash.start_datetime === start && clash.end_datetime === end) {
      return `"${clash.title}" already exists for ${when}.`;
    }
    return `${clash.venue} is already booked for "${clash.title}" (${when}). Choose another venue or time.`;
  }
  return null;
}

// GET /api/geofences/default-location
async function getDefaultLocation(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('cspc_latitude','cspc_longitude','cspc_label','cspc_zoom')`
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
    res.json({
      success: true,
      data: {
        lat: byKey.cspc_latitude ? Number(byKey.cspc_latitude) : config.defaultGeofence.lat,
        lng: byKey.cspc_longitude ? Number(byKey.cspc_longitude) : config.defaultGeofence.lng,
        label: byKey.cspc_label || config.defaultGeofence.label,
        zoom: byKey.cspc_zoom ? Number(byKey.cspc_zoom) : 18
      }
    });
  } catch (err) {
    next(err);
  }
}

// PUT /api/geofences/default-location { lat, lng, zoom }
async function saveDefaultLocation(req, res, next) {
  try {
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const zoom = Math.round(Number(req.body.zoom));
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, message: 'Invalid map position.' });
    }
    if (!Number.isFinite(zoom) || zoom < 3 || zoom > 21) {
      return res.status(400).json({ success: false, message: 'Invalid map zoom.' });
    }
    const values = [['cspc_latitude', lat.toFixed(7)], ['cspc_longitude', lng.toFixed(7)], ['cspc_zoom', String(zoom)]];
    for (const [key, value] of values) {
      await pool.query(
        `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, value]
      );
    }
    await logAction({ adminId: req.admin.id, action: 'update', module: 'geofence_default_location', details: { lat, lng, zoom }, ip: req.ip });
    res.json({ success: true, message: 'CSPC default map view saved.', data: { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)), zoom } });
  } catch (err) {
    next(err);
  }
}

// GET /api/geofences?limit=N (includes polygon points)
async function getGeofences(req, res, next) {
  try {
    const { limit } = req.query;
    const limitClause = limit && Number(limit) > 0 ? `LIMIT ${Number(limit)}` : '';
    const [rows] = await pool.query(
      `SELECT g.*, e.start_datetime, e.end_datetime, e.title AS event_title, e.created_at AS event_created_at,
              e.recurrence_type, e.recurrence_days, e.recurrence_end_date, e.is_recurring_parent, e.parent_event_id
       FROM geofences g JOIN events e ON g.event_id = e.id
       ORDER BY e.created_at DESC
       ${limitClause}`
    );

    const [allPoints] = await pool.query(
      `SELECT gp.geofence_id, gp.lat, gp.lng FROM geofence_points gp
       ORDER BY gp.geofence_id, gp.point_order`
    );
    const pointsByGeofence = {};
    for (const p of allPoints) {
      if (!pointsByGeofence[p.geofence_id]) pointsByGeofence[p.geofence_id] = [];
      pointsByGeofence[p.geofence_id].push({ lat: Number(p.lat), lng: Number(p.lng) });
    }

    const audiences = await eventAudience.loadAudiences(rows.map((g) => g.event_id));

    const now = new Date();
    const withStatus = rows.map((g) => {
      const start = new Date(g.start_datetime);
      const end = new Date(g.end_datetime);
      let computedStatus = 'upcoming';
      if (now >= start && now <= end) computedStatus = 'active';
      else if (now > end) computedStatus = 'expired';
      // Both empty = everyone (see services/eventAudience.js).
      const audience = audiences.get(g.event_id);
      return {
        ...g,
        points: pointsByGeofence[g.id] || [],
        computed_status: computedStatus,
        attendee_department_ids: audience ? [...audience.departmentIds] : [],
        attendee_employee_ids: audience ? [...audience.employeeIds] : []
      };
    });

    res.json({ success: true, data: withStatus });
  } catch (err) {
    next(err);
  }
}

// POST /api/geofences — event + polygon. recurrence_type: 'none' | 'weekly' | 'dates';
// each occurrence is its own event row linked by parent_event_id.
async function createGeofence(req, res, next) {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const {
      title, venue, start, end, points, center_lat, center_lng,
      recurrence_type = 'none', recurrence_days, recurrence_end_date
    } = req.body;
    if (!title || !start || !end || !Array.isArray(points) || points.length < 3) {
      return res.status(400).json({ success: false, message: 'Title, schedule, and at least 3 boundary points are required.' });
    }
    if (new Date(start).getTime() < Date.now()) {
      return res.status(400).json({ success: false, message: "The event start date/time can't be in the past." });
    }
    if (new Date(end).getTime() < new Date(start).getTime()) {
      return res.status(400).json({ success: false, message: "The end date/time can't be before the start." });
    }
    if (recurrence_type === 'weekly' && (!recurrence_days || !recurrence_end_date)) {
      return res.status(400).json({ success: false, message: 'Recurring schedules need at least one weekday and an end date.' });
    }
    const attendees = eventAudience.parseAttendees(req.body) || { departmentIds: [], employeeIds: [] };
    if (attendees.error) return res.status(400).json({ success: false, message: attendees.error });

    // Manually entered coordinates override the computed centroid.
    const hasManualCoords = center_lat !== undefined && center_lat !== null && center_lat !== '' &&
                             center_lng !== undefined && center_lng !== null && center_lng !== '';
    if (hasManualCoords && (isNaN(Number(center_lat)) || isNaN(Number(center_lng)))) {
      return res.status(400).json({ success: false, message: 'Latitude and Longitude must be valid numbers.' });
    }
    const center = hasManualCoords ? { lat: Number(center_lat), lng: Number(center_lng) } : centroidOf(points);

    const occurrences = expandRecurrenceDates({ recurrence_type, recurrence_days, start, end, recurrence_end_date });

    // Serialize creation so concurrent requests can't both pass the conflict check.
    const [[lock]] = await conn.query("SELECT GET_LOCK('geoattend_create_event', 10) AS got");
    if (!lock.got) {
      return res.status(503).json({ success: false, message: 'Another event is being saved. Please try again.' });
    }
    locked = true;

    const conflict = await findScheduleConflict(conn, { title, venue, occurrences });
    if (conflict) return res.status(409).json({ success: false, message: conflict });

    await conn.beginTransaction();

    let parentEventId = null;
    let firstGeofenceId = null;
    const createdEventIds = [];

    for (let occIndex = 0; occIndex < occurrences.length; occIndex++) {
      const occ = occurrences[occIndex];
      const isFirst = occIndex === 0;

      const [eventResult] = await conn.query(
        `INSERT INTO events
          (title, venue, start_datetime, end_datetime, is_active, recurrence_type, recurrence_days, recurrence_end_date, is_recurring_parent, parent_event_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [
          title, venue || null, toMysqlDatetime(occ.start), toMysqlDatetime(occ.end),
          recurrence_type, recurrence_type === 'weekly' ? recurrence_days : null,
          recurrence_type === 'weekly' ? recurrence_end_date : null,
          isFirst && occurrences.length > 1 ? 1 : 0,
          isFirst ? null : parentEventId
        ]
      );
      const eventId = eventResult.insertId;
      if (isFirst) parentEventId = eventId;
      createdEventIds.push(eventId);

      const [geofenceResult] = await conn.query(
        `INSERT INTO geofences (event_id, title, venue, shape_type, center_lat, center_lng, radius_meters, is_active)
         VALUES (?, ?, ?, 'polygon', ?, ?, NULL, 1)`,
        [eventId, title, venue || null, center.lat, center.lng]
      );
      const geofenceId = geofenceResult.insertId;
      if (isFirst) firstGeofenceId = geofenceId;

      for (let i = 0; i < points.length; i++) {
        await conn.query(
          `INSERT INTO geofence_points (geofence_id, point_order, lat, lng) VALUES (?, ?, ?, ?)`,
          [geofenceId, i, points[i].lat, points[i].lng]
        );
      }
    }

    await eventAudience.saveAudience(conn, createdEventIds, attendees);

    await conn.commit();
    await logAction({
      adminId: req.admin.id, action: 'create', module: 'geofence',
      details: {
        geofenceId: firstGeofenceId, pointCount: points.length, occurrences: occurrences.length,
        attendeeDepartments: attendees.departmentIds.length, attendeeEmployees: attendees.employeeIds.length
      },
      ip: req.ip
    });

    res.status(201).json({
      success: true,
      message: occurrences.length > 1
        ? `Event created (${occurrences.length} occurrences).`
        : 'Event created.',
      data: { id: firstGeofenceId, event_id: parentEventId, occurrence_count: occurrences.length, event_ids: createdEventIds }
    });
    // Not awaited so the save doesn't wait on Expo. Restricted events only
    // notify their attendees.
    const restricted = attendees.departmentIds.length > 0 || attendees.employeeIds.length > 0;
    const employeeIds = restricted
      ? await eventAudience.audienceEmployeeIds({ id: parentEventId }, { activeOnly: false }).catch(() => [])
      : null;
    pushService.notifyNewEvent({
      eventId: parentEventId, title, venue, start: occurrences[0].start, occurrenceCount: occurrences.length, employeeIds
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    if (locked) await conn.query("SELECT RELEASE_LOCK('geoattend_create_event')").catch(() => {});
    conn.release();
  }
}

// PUT /api/geofences/:id
async function updateGeofence(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { title, venue, start, end, points, center_lat, center_lng } = req.body;

    const [existing] = await conn.query('SELECT * FROM geofences WHERE id = ?', [id]);
    if (!existing[0]) return res.status(404).json({ success: false, message: 'Geofence not found.' });

    if (!Array.isArray(points) || points.length < 3) {
      return res.status(400).json({ success: false, message: 'At least 3 boundary points are required.' });
    }
    const attendees = eventAudience.parseAttendees(req.body); // null = keep the current attendees
    if (attendees && attendees.error) return res.status(400).json({ success: false, message: attendees.error });

    // Manually entered coordinates override the computed centroid.
    const hasManualCoords = center_lat !== undefined && center_lat !== null && center_lat !== '' &&
                             center_lng !== undefined && center_lng !== null && center_lng !== '';
    if (hasManualCoords && (isNaN(Number(center_lat)) || isNaN(Number(center_lng)))) {
      return res.status(400).json({ success: false, message: 'Latitude and Longitude must be valid numbers.' });
    }
    const center = hasManualCoords ? { lat: Number(center_lat), lng: Number(center_lng) } : centroidOf(points);

    const conflict = await findScheduleConflict(conn, {
      title, venue, occurrences: [{ start: new Date(start), end: new Date(end) }], excludeEventId: existing[0].event_id
    });
    if (conflict) return res.status(409).json({ success: false, message: conflict });

    await conn.beginTransaction();

    await conn.query(
      `UPDATE geofences SET title = ?, venue = ?, shape_type = 'polygon', center_lat = ?, center_lng = ?, radius_meters = NULL WHERE id = ?`,
      [title, venue, center.lat, center.lng, id]
    );
    await conn.query(
      `UPDATE events SET title = ?, venue = ?, start_datetime = ?, end_datetime = ? WHERE id = ?`,
      [title, venue, toMysqlDatetime(new Date(start)), toMysqlDatetime(new Date(end)), existing[0].event_id]
    );

    await conn.query('DELETE FROM geofence_points WHERE geofence_id = ?', [id]);
    for (let i = 0; i < points.length; i++) {
      await conn.query(
        `INSERT INTO geofence_points (geofence_id, point_order, lat, lng) VALUES (?, ?, ?, ?)`,
        [id, i, points[i].lat, points[i].lng]
      );
    }

    if (attendees) await eventAudience.saveAudience(conn, [existing[0].event_id], attendees);

    await conn.commit();
    await logAction({ adminId: req.admin.id, action: 'update', module: 'geofence', details: { id, pointCount: points.length }, ip: req.ip });

    res.json({ success: true, message: 'Event updated.' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

// DELETE /api/geofences/:id
async function deleteGeofence(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT event_id FROM geofences WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Geofence not found.' });

    // Cascades to the geofence and its points.
    await pool.query('DELETE FROM events WHERE id = ?', [rows[0].event_id]);
    await logAction({ adminId: req.admin.id, action: 'delete', module: 'geofence', details: { id: req.params.id }, ip: req.ip });

    res.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    next(err);
  }
}

// GET /api/geofences/attendee-options
async function getAttendeeOptions(req, res, next) {
  try {
    const [[departments], [employees]] = await Promise.all([
      pool.query('SELECT id, name FROM departments ORDER BY name'),
      pool.query(
        `SELECT id, employee_code, full_name, department_id, remark
         FROM employees WHERE is_approved = 1 ORDER BY full_name`
      )
    ]);
    res.json({ success: true, data: { departments, employees } });
  } catch (err) {
    next(err);
  }
}

// GET /api/geofences/mobile/active (employee: active and upcoming events)
async function getActiveForMobile(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT g.id, g.event_id, g.title, g.venue, e.start_datetime, e.end_datetime, e.department_id AS event_department_id
       FROM geofences g JOIN events e ON g.event_id = e.id
       WHERE g.is_active = 1 AND e.end_datetime >= NOW()
       ORDER BY e.start_datetime ASC`
    );

    const [allPoints] = await pool.query(
      `SELECT gp.geofence_id, gp.lat, gp.lng FROM geofence_points gp
       WHERE gp.geofence_id IN (SELECT id FROM geofences WHERE is_active = 1)
       ORDER BY gp.geofence_id, gp.point_order`
    );
    const pointsByGeofence = {};
    for (const p of allPoints) {
      if (!pointsByGeofence[p.geofence_id]) pointsByGeofence[p.geofence_id] = [];
      pointsByGeofence[p.geofence_id].push({ lat: Number(p.lat), lng: Number(p.lng) });
    }

    const [[[employee]], audiences] = await Promise.all([
      pool.query('SELECT id, department_id FROM employees WHERE id = ?', [req.employee.id]),
      eventAudience.loadAudiences(rows.map((g) => g.event_id))
    ]);
    const mine = employee
      ? rows.filter((g) => eventAudience.inAudience(employee, { department_id: g.event_department_id }, audiences.get(g.event_id)))
      : [];

    const now = new Date();
    const withStatus = mine.map(({ event_department_id, ...g }) => {
      const start = new Date(g.start_datetime);
      const end = new Date(g.end_datetime);
      const computed_status = now >= start && now <= end ? 'active' : 'upcoming';
      return { ...g, points: pointsByGeofence[g.id] || [], computed_status };
    });

    res.json({ success: true, data: withStatus });
  } catch (err) {
    next(err);
  }
}

module.exports = { getGeofences, createGeofence, updateGeofence, deleteGeofence, getActiveForMobile, getDefaultLocation, saveDefaultLocation, getAttendeeOptions };
