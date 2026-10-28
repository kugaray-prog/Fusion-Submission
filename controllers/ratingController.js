const pool = require('../config/db');
const { localDate } = require('../services/dateService');
const { logAction } = require('../services/auditService');
const { settleEndedEvents } = require('./attendanceController');
const { audienceEmployeeIds } = require('../services/eventAudience');

const expectedEmployeeIdsForEvent = (event) => audienceEmployeeIds(event);

// Upserts employee_ratings for events ended in [rangeStart, rangeEnd):
// Present/Late = 5, otherwise 1. Manual ratings are kept.
async function generateRatingsForRange(rangeStart, rangeEnd) {
  // Settle ended events first so ratings use final statuses.
  await settleEndedEvents();
  const [events] = await pool.query(
    `SELECT id, title, department_id, start_datetime, end_datetime
     FROM events
     WHERE end_datetime < NOW() AND start_datetime >= ? AND start_datetime < ?
     ORDER BY start_datetime ASC`,
    [rangeStart, rangeEnd]
  );
  if (!events.length) return events;

  for (const ev of events) {
    const [employeeIds, audienceIds] = await Promise.all([
      expectedEmployeeIdsForEvent(ev),
      audienceEmployeeIds(ev, { activeOnly: false })
    ]);
    // Drop auto ratings of employees removed from the attendee list.
    await pool.query(
      `DELETE FROM employee_ratings WHERE event_id = ? AND is_manual = 0 ${audienceIds.length ? 'AND employee_id NOT IN (?)' : ''}`,
      audienceIds.length ? [ev.id, audienceIds] : [ev.id]
    );
    if (!employeeIds.length) continue;

    const [attendanceRows] = await pool.query(
      `SELECT employee_id, attendance_status FROM attendance WHERE event_id = ?`,
      [ev.id]
    );
    const statusByEmployee = {};
    for (const r of attendanceRows) statusByEmployee[r.employee_id] = r.attendance_status;

    const ratingDate = localDate(ev.start_datetime);

    for (const empId of employeeIds) {
      const status = statusByEmployee[empId]; // undefined = never checked in = no-show
      const rating = status === 'Present' || status === 'Late' ? 5 : 1;
      await pool.query(
        `INSERT INTO employee_ratings (employee_id, event_id, rating_date, rating, is_manual)
         VALUES (?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
           rating = IF(is_manual = 0, VALUES(rating), rating),
           rating_date = VALUES(rating_date)`,
        [empId, ev.id, ratingDate, rating]
      );
    }
  }
  return events;
}

// GET /api/ratings?month=&year=&employee_id=&department=
// Rating Points = sum of event ratings / number of rated events.
async function getRatings(req, res, next) {
  try {
    const now = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year = Number(req.query.year) || now.getFullYear();
    const rangeStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const rangeEndDate = new Date(year, month, 1); // first day of next month
    const rangeEnd = localDate(rangeEndDate);

    const employeeId = req.query.employee_id && req.query.employee_id !== 'all' ? req.query.employee_id : null;
    const department = req.query.department && req.query.department !== 'all' ? req.query.department : null;

    await generateRatingsForRange(rangeStart, rangeEnd);

    const [events] = await pool.query(
      `SELECT e.id, e.title, e.venue, e.start_datetime, e.end_datetime, d.name AS department_name
       FROM events e
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE e.end_datetime < NOW() AND e.start_datetime >= ? AND e.start_datetime < ?
       ORDER BY e.start_datetime ASC`,
      [rangeStart, rangeEnd]
    );

    const conditions = ['e.is_approved = 1'];
    const params = [];
    if (employeeId) {
      conditions.push('e.id = ?');
      params.push(employeeId);
    }
    if (department) {
      conditions.push('d.name = ?');
      params.push(department);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [employees] = await pool.query(
      `SELECT e.id, e.employee_code, e.full_name, e.classification, d.name AS department_name
       FROM employees e JOIN departments d ON e.department_id = d.id
       ${where}
       ORDER BY e.full_name ASC`,
      params
    );

    let ratingRows = [];
    if (events.length) {
      const eventIds = events.map((e) => e.id);
      const [rows] = await pool.query(
        `SELECT employee_id, event_id, rating, is_manual, notes
         FROM employee_ratings WHERE event_id IN (?)`,
        [eventIds]
      );
      ratingRows = rows;
    }

    const eventById = {};
    for (const ev of events) eventById[ev.id] = ev;

    const byEmployee = {};
    for (const emp of employees) byEmployee[emp.id] = {};
    for (const r of ratingRows) {
      if (!byEmployee[r.employee_id]) byEmployee[r.employee_id] = {};
      byEmployee[r.employee_id][r.event_id] = { rating: r.rating, is_manual: !!r.is_manual, notes: r.notes };
    }

    const data = employees.map((emp) => {
      const ratings = byEmployee[emp.id] || {};
      const ratedEvents = Object.entries(ratings)
        .map(([eventId, r]) => {
          const ev = eventById[eventId];
          if (!ev) return null; // shouldn't happen, but don't let a stale row crash rendering
          return {
            event_id: ev.id,
            title: ev.title,
            venue: ev.venue,
            date: localDate(ev.start_datetime),
            rating: Number(r.rating),
            is_manual: r.is_manual
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.date.localeCompare(b.date) || a.event_id - b.event_id);

      const values = ratedEvents.map((r) => r.rating);
      const ratingCount = values.length;
      const totalRating = values.reduce((a, b) => a + b, 0);
      const ratingPoints = ratingCount ? Number((totalRating / ratingCount).toFixed(2)) : null;

      return {
        ...emp,
        ratings,
        rated_events: ratedEvents,
        rating_count: ratingCount,
        total_rating: ratingCount ? totalRating : null,
        rating_points: ratingPoints
      };
    });

    const eventsOut = events.map((e) => ({
      id: e.id,
      title: e.title,
      venue: e.venue,
      department_name: e.department_name,
      date: localDate(e.start_datetime),
      start_datetime: e.start_datetime,
      end_datetime: e.end_datetime
    }));

    res.json({ success: true, events: eventsOut, month, year, data });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/ratings { employee_id, event_id, rating (1 or 5), notes }
// Marked is_manual so auto-generation never overwrites it.
async function upsertRating(req, res, next) {
  try {
    const { employee_id, event_id, rating, notes } = req.body;
    const ratingNum = Number(rating);
    if (!employee_id || !event_id || (ratingNum !== 1 && ratingNum !== 5)) {
      return res.status(400).json({ success: false, message: 'employee_id, event_id, and a rating of either 1 (Absent) or 5 (Present) are required.' });
    }

    const [eventRows] = await pool.query('SELECT id, start_datetime FROM events WHERE id = ?', [event_id]);
    if (!eventRows.length) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }
    const ratingDate = localDate(eventRows[0].start_datetime);

    await pool.query(
      `INSERT INTO employee_ratings (employee_id, event_id, rating_date, rating, is_manual, notes, updated_by)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), is_manual = 1, notes = VALUES(notes), updated_by = VALUES(updated_by)`,
      [employee_id, event_id, ratingDate, ratingNum, notes || null, req.admin.id]
    );

    await logAction({ adminId: req.admin.id, action: 'set_rating', module: 'ratings', details: { employee_id, event_id, rating: ratingNum }, ip: req.ip });
    res.json({ success: true, message: 'Rating saved.' });
  } catch (err) {
    next(err);
  }
}

// CSC SPMS adjectival rating for a 1-5 numerical rating.
function adjectivalRating(score) {
  if (score == null) return null;
  if (score >= 4.5) return 'Outstanding';
  if (score >= 3.5) return 'Very Satisfactory';
  if (score >= 2.5) return 'Satisfactory';
  if (score >= 1.5) return 'Unsatisfactory';
  return 'Poor';
}

// Rating period: a semester (the usual IPCR/OPCR cycle) or the whole year.
function performancePeriod(year, period) {
  if (period === '1') return { start: `${year}-01-01`, end: `${year}-07-01`, label: `January – June ${year}` };
  if (period === '2') return { start: `${year}-07-01`, end: `${year + 1}-01-01`, label: `July – December ${year}` };
  return { start: `${year}-01-01`, end: `${year + 1}-01-01`, label: `January – December ${year}` };
}

// GET /api/ratings/performance?year=&period=1|2|year&department=
// IPCR = employee's average event rating; OPCR = office's average IPCR.
async function getPerformance(req, res, next) {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const period = ['1', '2'].includes(String(req.query.period)) ? String(req.query.period) : 'year';
    const department = req.query.department && req.query.department !== 'all' ? req.query.department : null;
    const range = performancePeriod(year, period);

    await generateRatingsForRange(range.start, range.end);

    const params = [range.start, range.end];
    let deptWhere = '';
    if (department) {
      deptWhere = 'AND d.name = ?';
      params.push(department);
    }
    const [rows] = await pool.query(
      `SELECT e.id, e.employee_code, e.full_name, e.position, e.classification,
              d.id AS department_id, d.name AS department_name,
              COUNT(r.id) AS rated_events,
              SUM(r.rating = 5) AS attended,
              SUM(r.rating = 1) AS missed,
              AVG(r.rating) AS score
       FROM employees e
       JOIN departments d ON e.department_id = d.id
       LEFT JOIN employee_ratings r ON r.employee_id = e.id AND r.rating_date >= ? AND r.rating_date < ?
       WHERE e.is_approved = 1 ${deptWhere}
       GROUP BY e.id
       ORDER BY d.name, e.full_name`,
      params
    );

    const ipcr = rows.map((r) => {
      const rated = Number(r.rated_events);
      const score = rated ? Number(Number(r.score).toFixed(2)) : null;
      return {
        employee_id: r.id,
        employee_code: r.employee_code,
        full_name: r.full_name,
        position: r.position,
        classification: r.classification,
        department_name: r.department_name,
        rated_events: rated,
        attended: Number(r.attended) || 0,
        missed: Number(r.missed) || 0,
        score,
        adjectival: adjectivalRating(score)
      };
    });

    const offices = new Map();
    for (const emp of ipcr) {
      if (!offices.has(emp.department_name)) {
        offices.set(emp.department_name, { department_name: emp.department_name, employees: 0, rated_employees: 0, scoreSum: 0, attended: 0, rated_events: 0 });
      }
      const o = offices.get(emp.department_name);
      o.employees += 1;
      o.attended += emp.attended;
      o.rated_events += emp.rated_events;
      if (emp.score != null) {
        o.rated_employees += 1;
        o.scoreSum += emp.score;
      }
    }
    const opcr = [...offices.values()].map((o) => {
      const score = o.rated_employees ? Number((o.scoreSum / o.rated_employees).toFixed(2)) : null;
      return {
        department_name: o.department_name,
        employees: o.employees,
        rated_employees: o.rated_employees,
        attendance_rate: o.rated_events ? Math.round((o.attended / o.rated_events) * 100) : null,
        score,
        adjectival: adjectivalRating(score)
      };
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.department_name.localeCompare(b.department_name));

    res.json({ success: true, year, period, label: range.label, ipcr, opcr });
  } catch (err) {
    next(err);
  }
}

module.exports = { getRatings, upsertRating, getPerformance };
