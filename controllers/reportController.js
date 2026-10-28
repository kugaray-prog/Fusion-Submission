const pool = require('../config/db');
const { settleEndedEvents, DISPLAY_STATUS_SQL } = require('./attendanceController');
const eventAudience = require('../services/eventAudience');

async function buildFilteredQuery({ department, year, month, employee_id, event_id, status }) {
  let where = 'WHERE 1=1';
  const params = [];

  if (department && department !== 'all') {
    where += ' AND d.name = ?';
    params.push(department);
  }
  if (year) {
    where += ' AND YEAR(a.attendance_date) = ?';
    params.push(year);
  }
  if (month && month !== 'all') {
    where += ' AND MONTH(a.attendance_date) = ?';
    params.push(Number(month) + 1);
  }
  if (employee_id && employee_id !== 'all') {
    where += ' AND a.employee_id = ?';
    params.push(employee_id);
  }
  if (event_id && event_id !== 'all') {
    where += ' AND a.event_id = ?';
    params.push(event_id);
  }
  if (status && status !== 'all') {
    where += ` AND ${DISPLAY_STATUS_SQL} = ?`;
    params.push(status);
  }

  return { where, params };
}

// GET /api/reports?department=&year=&month=&employee_id=&event_id=&status=
async function generateReport(req, res, next) {
  try {
    await settleEndedEvents();
    const { where, params } = await buildFilteredQuery(req.query);
    const [rows] = await pool.query(
      `SELECT a.attendance_date, a.time_in, a.time_out, ${DISPLAY_STATUS_SQL} AS attendance_status, a.verification_status,
              a.late_minutes, a.work_hours, e.full_name, e.employee_code, d.name AS department_name,
              ev.title AS event_title
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       JOIN departments d ON e.department_id = d.id
       LEFT JOIN events ev ON a.event_id = ev.id
       ${where}
       ORDER BY a.attendance_date DESC`,
      params
    );

    const summary = {
      total: rows.length,
      present: rows.filter((r) => r.attendance_status === 'Present').length,
      late: rows.filter((r) => r.attendance_status === 'Late').length,
      absent: rows.filter((r) => r.attendance_status === 'Absent').length
    };

    res.json({ success: true, data: rows, summary });
  } catch (err) {
    next(err);
  }
}

// Columns of both CSV and Excel exports.
const REPORT_EXPORT_FIELDS = ['Date', 'Employee', 'Employee ID', 'Department', 'Status', 'Late Minutes'];

async function exportReport(req, res, next) {
  try {
    await settleEndedEvents();
    const { where, params } = await buildFilteredQuery(req.query);
    const [rows] = await pool.query(
      `SELECT a.attendance_date AS Date, e.full_name AS Employee, e.employee_code AS 'Employee ID',
              d.name AS Department, ${DISPLAY_STATUS_SQL} AS Status, a.late_minutes AS 'Late Minutes'
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       JOIN departments d ON e.department_id = d.id
       LEFT JOIN events ev ON a.event_id = ev.id
       ${where}
       ORDER BY a.attendance_date DESC`,
      params
    );

    if (req.params.format === 'csv') {
      const { Parser } = require('json2csv');
      // `fields` is required: json2csv throws on empty data without it.
      const csv = new Parser({ fields: REPORT_EXPORT_FIELDS }).parse(rows);
      res.header('Content-Type', 'text/csv');
      res.attachment('attendance_report.csv');
      return res.send(csv);
    }

    if (req.params.format === 'excel') {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Attendance Report');
      // Always set so an empty export still has a header row.
      sheet.columns = REPORT_EXPORT_FIELDS.map((key) => ({ header: key, key, width: 20 }));
      if (rows.length > 0) {
        sheet.addRows(rows);
      }
      sheet.getRow(1).font = { bold: true };
      res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.attachment('attendance_report.xlsx');
      await workbook.xlsx.write(res);
      return res.end();
    }

    res.status(400).json({ success: false, message: 'Unsupported export format. Use csv or excel.' });
  } catch (err) {
    next(err);
  }
}

// An event past midnight has one row per date; the best status counts.
const STATUS_RANK = { Present: 4, Late: 3, Excused: 2, Absent: 1 };
const BREAKDOWN_KEY = { Present: 'present', Late: 'late', Excused: 'excused', Absent: 'absent' };
// Sort weight for a single event's status (includes "No time-in").
const STATUS_SORT = { Present: 4, Late: 3, Excused: 2, Absent: 1, 'No time-in': 0 };

const toPercent = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const emptyBreakdown = () => ({ present: 0, late: 0, excused: 0, absent: 0, no_time_in: 0 });

// GET /api/reports/insights?year=&month=&event_id=&order=most|least&rank_by=rate|count
// Office attendance ranking: attended = Present/Late, expected = event audience.
async function getInsights(req, res, next) {
  try {
    const order = req.query.order === 'least' ? 'least' : 'most';
    const rankBy = req.query.rank_by === 'count' ? 'count' : 'rate';
    const { year, month, event_id: eventId } = req.query;

    const isSet = (value) => value !== undefined && value !== '' && value !== 'all';
    if (isSet(year) && !Number.isInteger(Number(year))) {
      return res.status(400).json({ success: false, message: 'year must be a number, e.g. 2026.' });
    }
    if (isSet(month) && !(Number.isInteger(Number(month)) && Number(month) >= 0 && Number(month) <= 11)) {
      return res.status(400).json({ success: false, message: 'month must be 0 (January) to 11 (December), or "all".' });
    }
    if (isSet(eventId) && !Number.isInteger(Number(eventId))) {
      return res.status(400).json({ success: false, message: 'event_id must be a number, or "all".' });
    }

    // Close sessions left open past their event's end first.
    await settleEndedEvents();

    let where = 'WHERE 1=1';
    const params = [];
    if (isSet(eventId)) {
      where += ' AND ev.id = ?';
      params.push(Number(eventId));
    }
    if (isSet(year)) {
      where += ' AND YEAR(ev.start_datetime) = ?';
      params.push(Number(year));
    }
    if (isSet(month)) {
      where += ' AND MONTH(ev.start_datetime) = ?';
      params.push(Number(month) + 1);
    }

    const [matchedEvents] = await pool.query(
      `SELECT ev.id, ev.title, ev.venue, ev.start_datetime, ev.end_datetime, ev.department_id,
              (ev.start_datetime <= NOW()) AS has_started,
              (ev.end_datetime < NOW()) AS has_ended
       FROM events ev
       ${where}
       ORDER BY ev.start_datetime ASC`,
      params
    );
    const events = matchedEvents.filter((ev) => Number(ev.has_started) === 1);
    const singleEvent = events.length === 1;

    const scope = {
      events_matched: matchedEvents.length,
      event_count: events.length,
      upcoming_count: matchedEvents.length - events.length,
      ongoing_count: events.filter((ev) => Number(ev.has_ended) !== 1).length,
      event: singleEvent
        ? {
            id: events[0].id,
            title: events[0].title,
            venue: events[0].venue,
            start_datetime: events[0].start_datetime,
            end_datetime: events[0].end_datetime,
            ongoing: Number(events[0].has_ended) !== 1,
            department_name: null
          }
        : null
    };
    const overall = { expected: 0, attended: 0, missed: 0, rate: null, employees_involved: 0, departments_ranked: 0 };

    if (!events.length) {
      return res.json({ success: true, order, rank_by: rankBy, scope, overall, highlights: { highest: null, lowest: null }, data: [] });
    }

    const [[departments], [employees], [attendanceRows]] = await Promise.all([
      pool.query('SELECT id, name, office FROM departments ORDER BY name'),
      pool.query('SELECT id, employee_code, full_name, position, classification, remark, department_id FROM employees WHERE is_approved = 1'),
      pool.query(
        'SELECT employee_id, event_id, attendance_status, time_in, time_out FROM attendance WHERE event_id IN (?)',
        [events.map((ev) => ev.id)]
      )
    ]);

    if (singleEvent && events[0].department_id) {
      const dept = departments.find((d) => d.id === events[0].department_id);
      scope.event.department_name = dept ? dept.name : null;
    }

    // Best attendance row per employee per event, and who has rows per event.
    const rowFor = new Map();
    const attendeeIdsByEvent = new Map();
    for (const row of attendanceRows) {
      const key = `${row.employee_id}:${row.event_id}`;
      const kept = rowFor.get(key);
      if (!kept || (STATUS_RANK[row.attendance_status] || 0) > (STATUS_RANK[kept.attendance_status] || 0)) {
        rowFor.set(key, row);
      }
      if (!attendeeIdsByEvent.has(row.event_id)) attendeeIdsByEvent.set(row.event_id, new Set());
      attendeeIdsByEvent.get(row.event_id).add(row.employee_id);
    }

    const audiences = await eventAudience.loadAudiences(events.map((ev) => ev.id));

    // Tally every employee involved in each event.
    const statsByEmployee = new Map();
    for (const ev of events) {
      const audience = audiences.get(ev.id);
      const involved = new Set(employees.filter((emp) => eventAudience.isExpected(emp, ev, audience)).map((emp) => emp.id));
      for (const id of attendeeIdsByEvent.get(ev.id) || []) involved.add(id);

      for (const employeeId of involved) {
        if (!statsByEmployee.has(employeeId)) {
          statsByEmployee.set(employeeId, { expected: 0, breakdown: emptyBreakdown() });
        }
        const stats = statsByEmployee.get(employeeId);
        const row = rowFor.get(`${employeeId}:${ev.id}`);
        const status = row ? (BREAKDOWN_KEY[row.attendance_status] ? row.attendance_status : 'Absent') : 'No time-in';

        stats.expected += 1;
        stats.breakdown[row ? BREAKDOWN_KEY[status] : 'no_time_in'] += 1;
        if (singleEvent) {
          stats.status = status;
          stats.time_in = row ? row.time_in : null;
          stats.time_out = row ? row.time_out : null;
        }
      }
    }

    const dir = order === 'most' ? -1 : 1;
    // Most: best attendance first. Least: lowest rate first, then whoever
    // missed the most.
    const compareEmployees = (a, b) =>
      dir * (a.rate - b.rate) ||
      (order === 'most' ? b.attended - a.attended : b.missed - a.missed) ||
      dir * ((STATUS_SORT[a.status] || 0) - (STATUS_SORT[b.status] || 0)) ||
      a.full_name.localeCompare(b.full_name);

    const employeesByDept = new Map();
    for (const emp of employees) {
      const stats = statsByEmployee.get(emp.id);
      if (!stats) continue;
      const attended = stats.breakdown.present + stats.breakdown.late;
      const entry = {
        id: emp.id,
        employee_code: emp.employee_code,
        full_name: emp.full_name,
        position: emp.position,
        classification: emp.classification,
        expected: stats.expected,
        attended,
        missed: stats.expected - attended,
        rate: toPercent(attended, stats.expected),
        breakdown: stats.breakdown
      };
      if (singleEvent) Object.assign(entry, { status: stats.status, time_in: stats.time_in, time_out: stats.time_out });
      if (!employeesByDept.has(emp.department_id)) employeesByDept.set(emp.department_id, []);
      employeesByDept.get(emp.department_id).push(entry);
    }

    const data = departments.map((dept) => {
      const members = (employeesByDept.get(dept.id) || []).sort(compareEmployees);
      const breakdown = emptyBreakdown();
      let expected = 0;
      for (const member of members) {
        expected += member.expected;
        for (const key of Object.keys(breakdown)) breakdown[key] += member.breakdown[key];
      }
      const attended = breakdown.present + breakdown.late;
      return {
        rank: null,
        department_id: dept.id,
        department: dept.name,
        office: dept.office,
        employees_involved: members.length,
        employees_attended: members.filter((m) => m.attended > 0).length,
        expected,
        attended,
        missed: expected - attended,
        rate: toPercent(attended, expected),
        breakdown,
        employees: members
      };
    });

    const metric = (d) => (rankBy === 'count' ? d.attended : d.rate);
    const tieBreak = (d) => (rankBy === 'count' ? d.rate : d.attended);
    data.sort((a, b) => {
      // Offices with nobody expected can't be ranked, so they go last in both orders.
      if (a.expected > 0 !== b.expected > 0) return a.expected > 0 ? -1 : 1;
      if (!a.expected) return a.department.localeCompare(b.department);
      return dir * (metric(a) - metric(b)) || dir * (tieBreak(a) - tieBreak(b)) || a.department.localeCompare(b.department);
    });

    // Offices with identical figures share a rank (1, 2, 2, 4).
    let previous = null;
    data.forEach((d, index) => {
      if (!d.expected) return;
      const tied = previous && metric(previous) === metric(d) && tieBreak(previous) === tieBreak(d);
      d.rank = tied ? previous.rank : index + 1;
      previous = d;
    });

    const ranked = data.filter((d) => d.expected > 0);
    const brief = (d) => d && { department_id: d.department_id, department: d.department, rate: d.rate, attended: d.attended, expected: d.expected };
    const first = ranked[0];
    const last = ranked[ranked.length - 1];
    const highlights = {
      highest: brief(order === 'most' ? first : last) || null,
      lowest: brief(order === 'most' ? last : first) || null
    };

    for (const d of data) {
      overall.expected += d.expected;
      overall.attended += d.attended;
      overall.employees_involved += d.employees_involved;
    }
    overall.missed = overall.expected - overall.attended;
    overall.rate = toPercent(overall.attended, overall.expected);
    overall.departments_ranked = ranked.length;

    res.json({ success: true, order, rank_by: rankBy, scope, overall, highlights, data });
  } catch (err) {
    next(err);
  }
}

module.exports = { generateReport, exportReport, getInsights };
