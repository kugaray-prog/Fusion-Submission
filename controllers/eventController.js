const pool = require('../config/db');
const { logAction } = require('../services/auditService');

// Ongoing, then upcoming (soonest first), then completed (latest first).
const EVENT_STATUS_ORDER = `
  CASE WHEN NOW() BETWEEN e.start_datetime AND e.end_datetime THEN 0
       WHEN e.start_datetime > NOW() THEN 1
       ELSE 2 END,
  CASE WHEN e.start_datetime > NOW() THEN e.start_datetime END ASC,
  e.start_datetime DESC`;

// GET /api/events?search=&status=all|upcoming|ongoing|completed&page=&limit=
async function getAllEvents(req, res, next) {
  try {
    const { search = '', status = 'all', page = 1, limit = 25 } = req.query;
    // Recurring series can have hundreds of occurrences, so allow no cap.
    const noLimit = limit === 'all';
    const offset = (Number(page) - 1) * Number(limit);

    let where = 'WHERE 1=1';
    const params = [];
    if (search) {
      where += ' AND (e.title LIKE ? OR e.venue LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (status === 'upcoming') where += ' AND e.start_datetime > NOW()';
    if (status === 'ongoing') where += ' AND NOW() BETWEEN e.start_datetime AND e.end_datetime';
    if (status === 'completed') where += ' AND e.end_datetime < NOW()';

    const [rows] = await pool.query(
      `SELECT e.id, e.title, e.venue, e.start_datetime, e.end_datetime, e.recurrence_type,
              e.recurrence_days, e.recurrence_end_date, e.is_recurring_parent, e.parent_event_id,
              e.created_at, g.id AS geofence_id, g.is_active AS geofence_active,
              g.center_lat, g.center_lng,
              (SELECT COUNT(*) FROM attendance a WHERE a.event_id = e.id) AS attendance_count
       FROM events e
       LEFT JOIN geofences g ON g.event_id = e.id
       ${where}
       ORDER BY ${EVENT_STATUS_ORDER}
       ${noLimit ? '' : 'LIMIT ? OFFSET ?'}`,
      noLimit ? params : [...params, Number(limit), offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM events e ${where}`,
      params
    );

    // Per-status totals for the status chips (ignores the status filter).
    const searchWhere = search ? 'WHERE (e.title LIKE ? OR e.venue LIKE ?)' : '';
    const [[c]] = await pool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(e.start_datetime > NOW()), 0) AS upcoming,
              COALESCE(SUM(NOW() BETWEEN e.start_datetime AND e.end_datetime), 0) AS ongoing,
              COALESCE(SUM(e.end_datetime < NOW()), 0) AS completed
       FROM events e ${searchWhere}`,
      search ? [`%${search}%`, `%${search}%`] : []
    );
    const counts = { all: Number(c.total), upcoming: Number(c.upcoming), ongoing: Number(c.ongoing), completed: Number(c.completed) };

    const now = new Date();
    const data = rows.map((e) => {
      const start = new Date(e.start_datetime);
      const end = new Date(e.end_datetime);
      let computed_status = 'upcoming';
      if (now >= start && now <= end) computed_status = 'ongoing';
      else if (now > end) computed_status = 'completed';
      return { ...e, computed_status };
    });

    res.json({ success: true, data, counts, pagination: { page: Number(page), limit: noLimit ? total : Number(limit), total } });
  } catch (err) {
    next(err);
  }
}

// GET /api/events/ongoing
// Minimal list (id, title) for the Verification panels' event picker.
async function getOngoingEvents(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT id, title, venue, start_datetime, end_datetime
       FROM events
       WHERE NOW() BETWEEN start_datetime AND end_datetime
       ORDER BY start_datetime ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/events/:id
// The geofence and occurrences cascade; attendance keeps its rows (event_id NULL).
async function deleteEvent(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT id, title FROM events WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Event not found.' });

    await pool.query('DELETE FROM events WHERE id = ?', [rows[0].id]);
    await logAction({ adminId: req.admin.id, action: 'delete', module: 'event', details: { id: rows[0].id, title: rows[0].title }, ip: req.ip });

    res.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAllEvents, getOngoingEvents, deleteEvent };

