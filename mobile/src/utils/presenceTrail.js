import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-session record of GPS readings since the server last heard from the phone,
// so a session timed out while offline can be reopened if the phone stayed inside.
// ackAt: last server contact; lastAt: latest reading; brokenAt: when the run
// stopped vouching for presence (a gap, a mock reading, or a reading outside).

const STORAGE_KEY = 'presence_trail';
// Readings come every 1-3 s; a longer silence means Location went off or
// tracking stopped, so presence for that stretch can't be vouched for.
const MAX_GAP_MS = 30000;
const SAVE_EVERY_MS = 5000;
// Kept past the server's one-week claim window after an event ends.
const FORGET_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

let trails = null; // attendanceId -> { ackAt, lastAt, brokenAt }
let loading = null;
let lastSavedAt = 0;

async function load() {
  if (trails) return trails;
  if (!loading) {
    loading = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => { trails = (raw && JSON.parse(raw)) || {}; })
      .catch(() => { trails = {}; });
  }
  await loading;
  return trails;
}

function save(force) {
  const now = Date.now();
  if (!force && now - lastSavedAt < SAVE_EVERY_MS) return;
  lastSavedAt = now;
  Object.keys(trails).forEach((id) => {
    if (now - trails[id].ackAt > FORGET_AFTER_MS) delete trails[id];
  });
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trails)).catch(() => {});
}

// The server just heard from the phone about this session: a fresh run starts.
export async function noteServerHeard(attendanceId) {
  if (!attendanceId) return;
  const all = await load();
  const now = Date.now();
  all[attendanceId] = { ackAt: now, lastAt: now, brokenAt: null };
  save(true);
}

// Older saves had only a `broken` flag: treat those as broken from the start.
function brokenAtOf(t) {
  if (t.brokenAt != null) return t.brokenAt;
  return t.broken ? t.ackAt : null;
}

function breakAt(t, at) {
  const prev = brokenAtOf(t);
  t.brokenAt = prev == null ? at : Math.min(prev, at);
}

// A GPS reading, applied to every open session's run.
export async function noteReading({ at = Date.now(), mocked = false } = {}) {
  const all = await load();
  Object.values(all).forEach((t) => {
    if (at - t.lastAt > MAX_GAP_MS) breakAt(t, t.lastAt);
    if (mocked) breakAt(t, at);
    if (at > t.lastAt) t.lastAt = at;
  });
  save(false);
}

// A reading outside this session's geofence: presence ends here.
export async function noteOutside(attendanceId, at = Date.now()) {
  if (!attendanceId) return;
  const t = (await load())[attendanceId];
  const prev = t && brokenAtOf(t);
  if (!t || (prev != null && prev <= at)) return;
  breakAt(t, at);
  save(true);
}

// Seconds since the last server contact spent inside with no gaps, or undefined.
export async function offlineInsideSeconds(attendanceId, untilMs = Date.now()) {
  if (!attendanceId) return undefined;
  const t = (await load())[attendanceId];
  const brokenAt = t && brokenAtOf(t);
  if (!t || (brokenAt != null && brokenAt < untilMs) || untilMs - t.lastAt > MAX_GAP_MS) return undefined;
  return Math.max(1, Math.ceil((Date.now() - t.ackAt) / 1000));
}

// The unbroken run since the last server contact: { seconds, untilMs }, where
// untilMs is the last moment it still vouches for presence. Undefined if none.
export async function offlineInsideRun(attendanceId) {
  if (!attendanceId) return undefined;
  const t = (await load())[attendanceId];
  if (!t) return undefined;
  const brokenAt = brokenAtOf(t);
  const untilMs = brokenAt != null ? Math.min(brokenAt, t.lastAt) : t.lastAt;
  if (!(untilMs > t.ackAt)) return undefined;
  return { seconds: Math.max(1, Math.ceil((Date.now() - t.ackAt) / 1000)), untilMs };
}

// The session is closed for good (server confirmed): nothing left to vouch for.
export async function forgetTrail(attendanceId) {
  const all = await load();
  if (!all[attendanceId]) return;
  delete all[attendanceId];
  save(true);
}

export async function clearTrails() {
  trails = {};
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // ignore
  }
}
