// Load test for attendance: many phones time in at once, then send heartbeats
// every --interval seconds for --minutes, like the mobile app during an event.
//
//   node scripts/loadTestHeartbeat.js [--phones 1500] [--minutes 5] [--interval 12] [--rampup 0] [--radius 30] [--jitter 3] [--url http://localhost:2620/api]
//   node scripts/loadTestHeartbeat.js --cleanup
//
// Run from the project root (or inside the app container) so .env supplies the
// same JWT secret and database as the server. On Windows, run it inside the
// container: Docker Desktop's port forwarding drops many simultaneous
// connections from the host.
//
// Setup writes directly to the database: a "LOADTEST" department, test
// employees (codes LT-H…, emails @loadtest.local) with approved devices, and a
// circular geofenced event whose audience is only that department, so real
// employees never see it. Each phone sits at a fixed seat within --radius
// meters of the center and reports it with --jitter meters of GPS noise, so
// the geo-anomaly check (phones within 1 m of each other) runs as it would in
// a crowded venue. --rampup spreads the time-ins over that many seconds
// (0 = everyone at the same instant). --cleanup removes everything the setup
// created.
require('dotenv').config();
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const pool = require('../config/db');

const DEPT_NAME = 'LOADTEST Heartbeat';
const CODE_PREFIX = 'LT-H';
const EMAIL_DOMAIN = 'loadtest.local';
const EVENT_TITLE = 'LOADTEST Heartbeat Event';
const CENTER = { lat: 13.4044, lng: 123.3752 };
const ACCURACY_METERS = 5;
const WINDOW_SECONDS = 30;

function parseArgs() {
  const args = { phones: 1500, minutes: 5, interval: 12, rampup: 0, radius: 30, jitter: 3, url: `http://localhost:${process.env.PORT || 2620}/api` };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cleanup') args.cleanup = true;
    else if (a === '--url') args.url = argv[++i].replace(/\/$/, '');
    else if (['--phones', '--minutes', '--interval', '--rampup', '--radius', '--jitter'].includes(a)) args[a.slice(2)] = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// Offset (meters north/east) from a lat/lng.
function offset({ lat, lng }, north, east) {
  return {
    lat: lat + north / 111320,
    lng: lng + east / (111320 * Math.cos((lat * Math.PI) / 180))
  };
}

function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function mysqlDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function cleanup() {
  const [emps] = await pool.query('SELECT id FROM employees WHERE employee_code LIKE ? AND email LIKE ?', [`${CODE_PREFIX}%`, `%@${EMAIL_DOMAIN}`]);
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    // admin_notifications would otherwise be kept with employee_id set to NULL.
    await pool.query('DELETE FROM admin_notifications WHERE employee_id IN (?)', [ids]);
    // Attendance, sessions, logs, devices, anomalies and the rest cascade.
    await pool.query('DELETE FROM employees WHERE id IN (?)', [ids]);
  }
  const [ev] = await pool.query('DELETE FROM events WHERE title = ?', [EVENT_TITLE]);
  await pool.query('DELETE FROM departments WHERE name = ?', [DEPT_NAME]);
  console.log(`Deleted ${ids.length} test employee(s) and ${ev.affectedRows} test event(s).`);
}

async function setup(args) {
  await cleanup();

  const [dept] = await pool.query('INSERT INTO departments (name, description) VALUES (?, ?)', [DEPT_NAME, 'Created by scripts/loadTestHeartbeat.js']);
  const deptId = dept.insertId;

  const runId = Date.now().toString(36).slice(-4);
  const phones = [];
  for (let i = 0; i < args.phones; i++) {
    const n = String(i + 1).padStart(5, '0');
    phones.push({
      code: `${CODE_PREFIX}${runId}${n}`,
      email: `lth${runId}-${n}@${EMAIL_DOMAIN}`,
      deviceUid: `loadtest-hb-${runId}-${n}`,
      name: `Heartbeat Tester ${n}`
    });
  }
  // Batched inserts: one round trip per 500 rows.
  for (let i = 0; i < phones.length; i += 500) {
    const batch = phones.slice(i, i + 500);
    const [res] = await pool.query(
      'INSERT INTO employees (employee_code, full_name, surname, given_name, department_id, email, is_approved) VALUES ?',
      [batch.map((p) => [p.code, p.name, `Tester${p.code.slice(-5)}`, 'Heartbeat', deptId, p.email, 1])]
    );
    batch.forEach((p, j) => { p.employeeId = res.insertId + j; });
    await pool.query(
      'INSERT INTO mobile_devices (employee_id, device_uid, model, brand, os, status) VALUES ?',
      [batch.map((p) => [p.employeeId, p.deviceUid, 'LoadTest', 'LoadTest', 'test', 'approved'])]
    );
  }

  const now = Date.now();
  const [event] = await pool.query(
    'INSERT INTO events (title, venue, start_datetime, end_datetime, department_id, is_active) VALUES (?, ?, ?, ?, ?, 1)',
    [EVENT_TITLE, 'Load test', mysqlDateTime(new Date(now - 60 * 1000)), mysqlDateTime(new Date(now + (args.minutes + 10) * 60 * 1000)), deptId]
  );
  const eventId = event.insertId;
  await pool.query('INSERT INTO event_attendee_departments (event_id, department_id) VALUES (?, ?)', [eventId, deptId]);
  await pool.query(
    'INSERT INTO geofences (event_id, title, venue, shape_type, center_lat, center_lng, radius_meters, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    [eventId, EVENT_TITLE, 'Load test', 'circle', CENTER.lat, CENTER.lng, Math.ceil(args.radius + 50)]
  );

  for (const p of phones) {
    p.token = jwt.sign({ id: p.employeeId, employee_code: p.code, type: 'employee' }, config.jwt.secret, { expiresIn: '1d' });
    // Uniform over the disc.
    const r = args.radius * Math.sqrt(Math.random());
    const t = 2 * Math.PI * Math.random();
    p.seat = offset(CENTER, r * Math.cos(t), r * Math.sin(t));
  }
  return { eventId, phones };
}

function reading(p, jitter) {
  return offset(p.seat, gaussian() * jitter, gaussian() * jitter);
}

async function post(url, p, body) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.token}`, 'x-device-uid': p.deviceUid },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ms: Date.now() - started, json };
  } catch (err) {
    return { status: err.name === 'TimeoutError' ? 'timeout' : 'network', ms: Date.now() - started, json: { message: err.message } };
  }
}

function percentile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
}

function summarize(label, results) {
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const statuses = {};
  for (const r of results) statuses[r.status] = (statuses[r.status] || 0) + 1;
  const statusText = Object.entries(statuses).map(([s, n]) => `${s}×${n}`).join(' ');
  console.log(`${label}  n=${results.length}  p50 ${percentile(times, 0.5)}ms  p95 ${percentile(times, 0.95)}ms  max ${times[times.length - 1] || 0}ms  [${statusText}]`);
}

async function main() {
  const args = parseArgs();
  if (args.cleanup) return cleanup();

  console.log(`Setting up ${args.phones} test phones...`);
  const { eventId, phones } = await setup(args);

  // 1. Time-ins, all at once or spread over --rampup seconds.
  console.log(args.rampup ? `Time-in: ${args.phones} phones over ${args.rampup}s...` : `Time-in: ${args.phones} phones at once...`);
  const timeIns = await Promise.all(phones.map(async (p) => {
    if (args.rampup) await new Promise((r) => setTimeout(r, Math.random() * args.rampup * 1000));
    const pos = reading(p, args.jitter);
    return post(`${args.url}/attendance/submit`, p, {
      employee_id: p.employeeId, device_uid: p.deviceUid, event_id: eventId,
      latitude: pos.lat, longitude: pos.lng, accuracy: ACCURACY_METERS
    }).then((r) => {
      p.attendanceId = r.json && r.json.data && r.json.data.id;
      return r;
    });
  }));
  summarize('time-in      ', timeIns);
  const failed = timeIns.filter((r) => r.status !== 200 && r.status !== 201);
  if (failed.length) console.log(`  sample error: ${failed[0].json.message || failed[0].status}`);

  // 2. Heartbeats, each phone on its own schedule spread across the interval.
  const active = phones.filter((p) => p.attendanceId);
  console.log(`\nHeartbeats: ${active.length} phones every ${args.interval}s for ${args.minutes} min (~${Math.round(active.length / args.interval)} req/s)...`);
  const endAt = Date.now() + args.minutes * 60 * 1000;
  const flagged = new Set(phones.filter((p, i) => timeIns[i].json?.data?.requiresFaceVerification).map((p) => p.employeeId));
  let windowResults = [];
  const allResults = [];
  const startedAt = Date.now();

  const reporter = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    summarize(`t=${String(elapsed).padStart(4)}s     `, windowResults);
    if (flagged.size) console.log(`  flagged for face verification so far: ${flagged.size}`);
    windowResults = [];
  }, WINDOW_SECONDS * 1000);

  await Promise.all(active.map(async (p) => {
    await new Promise((r) => setTimeout(r, Math.random() * args.interval * 1000));
    while (Date.now() < endAt) {
      const nextAt = Date.now() + args.interval * 1000;
      const pos = reading(p, args.jitter);
      const r = await post(`${args.url}/attendance/${p.attendanceId}/heartbeat`, p, {
        latitude: pos.lat, longitude: pos.lng, accuracy: ACCURACY_METERS, observed_at: new Date().toISOString()
      });
      if (r.json && r.json.data && r.json.data.requiresFaceVerification) flagged.add(p.employeeId);
      windowResults.push(r);
      allResults.push(r);
      await new Promise((res) => setTimeout(res, Math.max(0, nextAt - Date.now())));
    }
  }));
  clearInterval(reporter);

  console.log('');
  summarize('all heartbeats', allResults);
  console.log(`Flagged for face verification: ${flagged.size} of ${active.length} (geo-anomaly, radius ${args.radius} m, jitter ${args.jitter} m)`);
  console.log('\nRemove the test data with: node scripts/loadTestHeartbeat.js --cleanup');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
