// Expo push notifications for new events. Tokens are saved by
// PUT /api/devices/push-token. Never throws: failures are only logged.
const pool = require('../config/db');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100; // Expo's per-request limit

function isExpoToken(token) {
  return typeof token === 'string' && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

async function sendBatch(messages) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(messages)
  });
  if (!res.ok) throw new Error(`Expo push responded ${res.status}`);
  const { data } = await res.json();
  // Uninstalled app or revoked permission: drop the token.
  const dead = (data || [])
    .map((ticket, i) => (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' ? messages[i].to : null))
    .filter(Boolean);
  if (dead.length) await pool.query('UPDATE mobile_devices SET push_token = NULL WHERE push_token IN (?)', [dead]);
}

// `employeeIds` limits the push to those employees; null = everyone.
async function sendToApprovedDevices(build, employeeIds = null) {
  if (employeeIds && !employeeIds.length) return;
  const [rows] = await pool.query(
    `SELECT DISTINCT d.push_token
       FROM mobile_devices d
       JOIN employees e ON e.id = d.employee_id
      WHERE d.status = 'approved' AND e.is_approved = 1 AND d.push_token IS NOT NULL
        ${employeeIds ? 'AND e.id IN (?)' : ''}`,
    employeeIds ? [employeeIds] : []
  );
  const messages = rows.map(r => r.push_token).filter(isExpoToken).map(build);
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    await sendBatch(messages.slice(i, i + BATCH_SIZE));
  }
}

function notifyNewEvent({ eventId, title, venue, start, occurrenceCount = 1, employeeIds = null }) {
  const when = start ? new Date(String(start).replace(' ', 'T')) : null;
  const whenText = when && !isNaN(when)
    ? when.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  const body = [venue, whenText].filter(Boolean).join(' · ')
    + (occurrenceCount > 1 ? ` (${occurrenceCount} occurrences)` : '');

  sendToApprovedDevices((to) => ({
    to,
    title: `New event: ${title || 'Untitled'}`,
    body: body || 'Open GeoAttend for details.',
    sound: 'default',
    channelId: 'event-reminders',
    data: { type: 'new_event', eventId }
  }), employeeIds).catch((err) => console.error('[push] New-event notification failed:', err.message));
}

module.exports = { isExpoToken, notifyNewEvent };
