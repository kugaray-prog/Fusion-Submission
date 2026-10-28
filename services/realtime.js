// WebSocket at /ws carrying only { type: 'change', topic } signals; clients
// re-fetch through the REST API. Admins receive every topic, employees only
// EMPLOYEE_TOPICS plus their own notifyEmployee topics. Broadcasts are
// coalesced per topic.
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const pool = require('../config/db');
const { getBlockedStatus } = require('./deviceAccess');

const COALESCE_MS = 1500;
const PING_MS = 30000;

const IGNORED_SEGMENTS = new Set(['auth', 'employee-auth', 'nav', 'health']);
const EMPLOYEE_TOPICS = new Set(['events', 'geofences']);

let wss = null;
const pending = new Map(); // coalesce key -> timer

// Token comes from ?token= (browsers can't set WebSocket headers). Employees
// also send ?device= so blocked phones are refused.
async function authenticate(req) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const token = params.get('token');
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    return null;
  }
  if (decoded.type === 'google_pending') return null;
  if (decoded.type === 'employee') {
    if (await getBlockedStatus(params.get('device'), decoded.id)) return null;
    const [rows] = await pool.query('SELECT id FROM employees WHERE id = ?', [decoded.id]);
    return rows[0] ? { role: 'employee', id: rows[0].id } : null;
  }
  const [rows] = await pool.query('SELECT id, is_active FROM admin_accounts WHERE id = ?', [decoded.id]);
  return rows[0] && rows[0].is_active ? { role: 'admin', id: rows[0].id } : null;
}

function attach(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    // Prevents a crash if the client disconnects while authenticate() is pending.
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);
    try {
      const client = await authenticate(req);
      if (!client) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      socket.removeListener('error', onSocketError);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.client = client;
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('error', () => {});
      });
    } catch (err) {
      console.error('[realtime] Upgrade failed:', err.message);
      socket.destroy();
    }
  });

  // Drop dead connections and keep idle ones alive through proxies.
  const pinger = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_MS);
  wss.on('close', () => clearInterval(pinger));
}

function send(key, topic, shouldReceive) {
  if (!wss || pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    const message = JSON.stringify({ type: 'change', topic });
    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN && shouldReceive(ws.client)) ws.send(message);
    });
  }, COALESCE_MS));
}

// Sends immediately, replacing any queued send for the same key.
function sendNow(key, topic, shouldReceive) {
  if (!wss) return;
  clearTimeout(pending.get(key));
  pending.delete(key);
  const message = JSON.stringify({ type: 'change', topic });
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && shouldReceive(ws.client)) ws.send(message);
  });
}

function broadcastNow(topic) {
  sendNow(topic, topic, (client) => client.role === 'admin' || EMPLOYEE_TOPICS.has(topic));
}

function broadcast(topic) {
  send(topic, topic, (client) => client.role === 'admin' || EMPLOYEE_TOPICS.has(topic));
}

function notifyEmployee(employeeId, topic) {
  if (!employeeId) return;
  const id = Number(employeeId);
  send(`employee:${id}:${topic}`, topic, (client) => client.role === 'employee' && client.id === id);
}

// Announces each successful POST/PUT/PATCH/DELETE under /api.
function broadcastMutations(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // Read now: routers rewrite req.path before the response finishes.
  const segment = req.path.split('/')[1];
  // Link-device also changes attempt counts/locks on 401 and 423.
  if (segment === 'employee-auth' && req.path === '/employee-auth/link-device') {
    res.on('finish', () => {
      if (res.statusCode === 401 || res.statusCode === 423) return broadcastNow('employees');
      if (res.statusCode >= 400) return;
      ['employees', 'devices', 'face'].forEach(broadcastNow);
    });
    return next();
  }
  if (!segment || IGNORED_SEGMENTS.has(segment)) return next();
  // Handlers can opt out via res.locals.noBroadcast. Employee attendance writes
  // (heartbeats) are coalesced; everything else goes out immediately.
  res.on('finish', () => {
    if (res.statusCode >= 400 || res.locals.noBroadcast) return;
    if (segment === 'attendance' && !req.admin) broadcast(segment);
    else broadcastNow(segment);
  });
  next();
}

// Announce clock-driven changes (events starting/ending, face locks expiring).
let lastEventCheck = null;
async function announceEventBoundaries() {
  const [[{ now }]] = await pool.query('SELECT NOW() AS now');
  if (lastEventCheck) {
    const [[{ crossed }]] = await pool.query(
      `SELECT COUNT(*) AS crossed FROM events
       WHERE (start_datetime > ? AND start_datetime <= ?) OR (end_datetime > ? AND end_datetime <= ?)`,
      [lastEventCheck, now, lastEventCheck, now]
    );
    if (crossed) {
      broadcastNow('events');
      broadcastNow('attendance-status');
    }
    // Identity Verification Locks also run out by the clock.
    const [[{ unlocked }]] = await pool.query(
      'SELECT COUNT(*) AS unlocked FROM employees WHERE face_locked_until > ? AND face_locked_until <= ?',
      [lastEventCheck, now]
    );
    if (unlocked) broadcastNow('employees');
  }
  lastEventCheck = now;
}

module.exports = { attach, broadcast, broadcastNow, notifyEmployee, broadcastMutations, announceEventBoundaries };
