const pool = require('../config/db');

// Who an event expects: chosen offices and/or employees, or (when none are
// chosen) its department, or everyone. Only expected employees can time in,
// get the push, and are counted Absent.

// eventId -> { departmentIds, employeeIds } for events with a chosen audience.
async function loadAudiences(eventIds, conn = pool) {
  const audiences = new Map();
  if (!eventIds.length) return audiences;
  const [[deptRows], [empRows]] = await Promise.all([
    conn.query('SELECT event_id, department_id FROM event_attendee_departments WHERE event_id IN (?)', [eventIds]),
    conn.query('SELECT event_id, employee_id FROM event_attendee_employees WHERE event_id IN (?)', [eventIds])
  ]);
  const entry = (eventId) => {
    if (!audiences.has(eventId)) audiences.set(eventId, { departmentIds: new Set(), employeeIds: new Set() });
    return audiences.get(eventId);
  };
  for (const r of deptRows) entry(r.event_id).departmentIds.add(r.department_id);
  for (const r of empRows) entry(r.event_id).employeeIds.add(r.employee_id);
  return audiences;
}

function inAudience(emp, event, audience) {
  if (audience) return audience.departmentIds.has(emp.department_id) || audience.employeeIds.has(emp.id);
  return !event.department_id || emp.department_id === event.department_id;
}

// In the audience and not on leave.
function isExpected(emp, event, audience) {
  return emp.remark === 'Active' && inAudience(emp, event, audience);
}

async function audienceEmployeeIds(event, { activeOnly = true } = {}) {
  const [audiences, [employees]] = await Promise.all([
    loadAudiences([event.id]),
    pool.query('SELECT id, department_id, remark FROM employees WHERE is_approved = 1')
  ]);
  const audience = audiences.get(event.id);
  const check = activeOnly ? isExpected : inAudience;
  return employees.filter((emp) => check(emp, event, audience)).map((emp) => emp.id);
}

// Parses body.attendees: { mode: 'all' } or { mode: 'selected', department_ids,
// employee_ids }. Returns { departmentIds, employeeIds }, null when absent
// (leave unchanged), or { error }.
function parseAttendees(body) {
  const attendees = body && body.attendees;
  if (attendees === undefined || attendees === null) return null;
  if (attendees.mode !== 'selected') return { departmentIds: [], employeeIds: [] };
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const departmentIds = ids(attendees.department_ids);
  const employeeIds = ids(attendees.employee_ids);
  if (!departmentIds.length && !employeeIds.length) {
    return { error: 'Choose at least one office or employee who must attend, or set Required Attendees to "All employees".' };
  }
  return { departmentIds, employeeIds };
}

async function saveAudience(conn, eventIds, { departmentIds, employeeIds }) {
  if (!eventIds.length) return;
  await conn.query('DELETE FROM event_attendee_departments WHERE event_id IN (?)', [eventIds]);
  await conn.query('DELETE FROM event_attendee_employees WHERE event_id IN (?)', [eventIds]);
  if (departmentIds.length) {
    const [rows] = await conn.query('SELECT id FROM departments WHERE id IN (?)', [departmentIds]);
    if (rows.length) {
      await conn.query('INSERT INTO event_attendee_departments (event_id, department_id) VALUES ?', [
        eventIds.flatMap((eventId) => rows.map((r) => [eventId, r.id]))
      ]);
    }
  }
  if (employeeIds.length) {
    const [rows] = await conn.query('SELECT id FROM employees WHERE id IN (?)', [employeeIds]);
    if (rows.length) {
      await conn.query('INSERT INTO event_attendee_employees (event_id, employee_id) VALUES ?', [
        eventIds.flatMap((eventId) => rows.map((r) => [eventId, r.id]))
      ]);
    }
  }
}

module.exports = { loadAudiences, inAudience, isExpected, audienceEmployeeIds, parseAttendees, saveAudience };
