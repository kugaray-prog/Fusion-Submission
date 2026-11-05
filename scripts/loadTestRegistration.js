// Load test for mobile self-registration (POST /api/employee-auth/link-device).
// Fires many registrations at once and reports status codes and latency.
//
//   node scripts/loadTestRegistration.js --images <file-or-folder> [--count 300] [--url http://localhost:2620/api]
//   node scripts/loadTestRegistration.js --cleanup
//
// Run from the project root so .env supplies the same JWT secret and database
// as the server. Pending tokens are signed locally, so no Google sign-in is
// needed. Test employees use the code prefix LT- and emails @loadtest.local.
//
// With one photo (or fewer photos than --count), every request after the first
// that reuses a face gets 409 "face already registered" — the full face
// pipeline still runs, but only distinct faces create employees.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const config = require('../config/config');

const CODE_PREFIX = 'LT-';
const EMAIL_DOMAIN = 'loadtest.local';

function parseArgs() {
  const args = { count: 300, url: `http://localhost:${process.env.PORT || 2620}/api` };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cleanup') args.cleanup = true;
    else if (a === '--count') args.count = Number(argv[++i]);
    else if (a === '--url') args.url = argv[++i].replace(/\/$/, '');
    else if (a === '--images') args.images = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function listImages(target) {
  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs.readdirSync(target).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => path.join(target, f))
    : [target];
  if (!files.length) throw new Error(`No .jpg/.png/.webp images in ${target}`);
  return files;
}

async function cleanup() {
  const pool = require('../config/db');
  const [rows] = await pool.query('SELECT id FROM employees WHERE employee_code LIKE ? AND email LIKE ?', [`${CODE_PREFIX}%`, `%@${EMAIL_DOMAIN}`]);
  if (rows.length) {
    // Faces, devices and the rest cascade with the employee.
    await pool.query('DELETE FROM employees WHERE id IN (?)', [rows.map((r) => r.id)]);
  }
  console.log(`Deleted ${rows.length} load-test employee(s). Their photos remain in uploads/faces.`);
  await pool.end();
}

async function registerOne(i, runId, image, url, department) {
  const n = String(i + 1).padStart(5, '0');
  const email = `lt${runId}-${n}@${EMAIL_DOMAIN}`;
  const pendingToken = jwt.sign({ type: 'google_pending', email, given_name: 'Load', family_name: `Test${n}` }, config.jwt.secret, { expiresIn: '30m' });

  const form = new FormData();
  const fields = {
    pendingToken,
    employee_code: `${CODE_PREFIX}${runId}${n}`.slice(0, 20),
    first_name: 'Load',
    last_name: `Test${n}`,
    device_uid: `loadtest-${runId}-${n}`,
    device_model: 'LoadTest',
    device_brand: 'LoadTest',
    device_os: 'test',
    department,
    position: 'Load Tester',
    classification: 'Permanent Administrative',
    gender: 'Prefer not to say',
    liveness_verified: 'true',
    liveness_actions: 'loadtest'
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('image', new Blob([image.data], { type: image.type }), image.name);

  const started = Date.now();
  try {
    const res = await fetch(`${url}/employee-auth/link-device`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ms: Date.now() - started, result: body.result || '', message: body.message || '' };
  } catch (err) {
    return { status: err.name === 'TimeoutError' ? 'timeout' : 'network', ms: Date.now() - started, message: err.message };
  }
}

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
}

async function main() {
  const args = parseArgs();
  if (args.cleanup) return cleanup();
  if (!args.images) throw new Error('Pass --images <photo or folder of face photos>, or --cleanup.');

  const images = listImages(args.images).map((file) => ({
    name: path.basename(file),
    type: /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg',
    data: fs.readFileSync(file)
  }));

  const deptRes = await fetch(`${args.url}/employee-auth/departments`);
  const deptBody = await deptRes.json();
  const departments = deptBody.data || deptBody.departments || [];
  const department = departments[0] && (departments[0].name || departments[0]);
  if (!department) throw new Error('No departments returned by the server; seed the database first.');

  const runId = Date.now().toString(36).slice(-4);
  console.log(`Sending ${args.count} registrations at once to ${args.url} (${images.length} distinct photo(s), run ${runId})...`);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: args.count }, (_, i) => registerOne(i, runId, images[i % images.length], args.url, department))
  );
  const totalMs = Date.now() - started;

  const byOutcome = {};
  for (const r of results) {
    const key = `${r.status}${r.result ? ` ${r.result}` : ''}`;
    byOutcome[key] = byOutcome[key] || { count: 0, sample: r.message };
    byOutcome[key].count++;
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b);

  console.log(`\nFinished in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Latency: p50 ${percentile(times, 50)}ms, p95 ${percentile(times, 95)}ms, max ${times[times.length - 1]}ms\n`);
  for (const [key, { count, sample }] of Object.entries(byOutcome).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`${String(count).padStart(6)}  ${key}${sample ? `  — ${sample}` : ''}`);
  }
  console.log('\nRemove the test employees afterwards with: node scripts/loadTestRegistration.js --cleanup');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
