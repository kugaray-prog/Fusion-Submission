import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-session record of GPS readings since the server last heard from the phone,
// so a session timed out while offline can be reopened if the phone stayed inside.
// ackAt: last server contact; lastAt: latest reading; broken: gap or mock reading.

const STORAGE_KEY = 'presence_trail';
// Readings come every 1-3 s; a longer silence means Location went off or
// tracking stopped, so presence for that stretch can't be vouched for.
const MAX_GAP_MS = 30000;
const SAVE_EVERY_MS = 5000;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

let trails = null; // attendanceId -> { ackAt, lastAt, broken }
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
  all[attendanceId] = { ackAt: now, lastAt: now, broken: false };
  save(true);
}

// A GPS reading, applied to every open session's run.
export async function noteReading({ at = Date.now(), mocked = false } = {}) {
  const all = await load();
  Object.values(all).forEach((t) => {
    if (mocked || at - t.lastAt > MAX_GAP_MS) t.broken = true;
    if (at > t.lastAt) t.lastAt = at;
  });
  save(false);
}

// Seconds since the last server contact spent inside with no gaps, or undefined.
export async function offlineInsideSeconds(attendanceId, untilMs = Date.now()) {
  if (!attendanceId) return undefined;
  const t = (await load())[attendanceId];
  if (!t || t.broken || untilMs - t.lastAt > MAX_GAP_MS) return undefined;
  return Math.max(1, Math.ceil((Date.now() - t.ackAt) / 1000));
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
