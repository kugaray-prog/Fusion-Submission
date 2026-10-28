import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { submitAttendance, sendHeartbeat, getMyHistory, getGeofences } from '../api/client';
import { getDeviceUid } from '../utils/device';
import { isInsideGeofence, isEventActiveNow, localDateString } from '../utils/geofence';
import { alertFaceVerificationRequired } from '../utils/faceVerificationAlert';
import Notifications from '../utils/notificationsModule';
import { noteServerHeard, noteReading, offlineInsideSeconds, forgetTrail } from '../utils/presenceTrail';

// Background attendance (app backgrounded or closed), via an Android foreground
// service. Per reading: time in when inside with no session, keep-alive pings
// while inside, time out on the first outside reading (retried if offline).
// If Location is turned off, readings stop and the server times out the session
// after ~30 s of silence. Does nothing while the app is in the foreground.

export const BACKGROUND_ATTENDANCE_TASK = 'geoattend-background-attendance';

const STATE_KEY = 'bg_attendance_state';
// Matches the in-app tracker's HEARTBEAT_INTERVAL_MS: above the server's
// 10 s ping debounce, well inside its 30 s silence window.
const KEEPALIVE_MS = 12000;
const CHECK_IN_RETRY_MS = 5000;
// How often the event list is re-fetched while the app is closed, so an
// event added or started meanwhile is still picked up.
const GEOFENCE_REFRESH_MS = 60000;
const CHANNEL_ID = 'attendance-updates';

// State: { employeeId, geofences, geofencesFetchedAt, sessions: { [eventId]: { id, open } },
//   pendingExits: { [eventId]: reading }, lastSentAt: { [attendanceId]: ms }, lastFailAt: { [eventId]: ms } }
async function readState() {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return {
      employeeId: s.employeeId || null,
      geofences: s.geofences || [],
      geofencesFetchedAt: s.geofencesFetchedAt || 0,
      sessions: s.sessions || {},
      pendingExits: s.pendingExits || {},
      lastSentAt: s.lastSentAt || {},
      lastFailAt: s.lastFailAt || {}
    };
  } catch (e) {
    return { employeeId: null, geofences: [], geofencesFetchedAt: 0, sessions: {}, pendingExits: {}, lastSentAt: {}, lastFailAt: {} };
  }
}

async function writeState(state) {
  try {
    await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {
    // Non-fatal -- the next reading works from what's still there.
  }
}

// Called by the in-app tracker; keeps an undelivered exit unless the app has its own.
export async function saveBackgroundState({ employeeId, geofences, sessions, pendingExits }) {
  const prev = await readState();
  const keptExits = {};
  Object.entries(prev.pendingExits).forEach(([eventId, exit]) => {
    if (sessions[eventId]?.id === exit.attendanceId && sessions[eventId]?.open) keptExits[eventId] = exit;
  });
  await writeState({
    ...prev,
    employeeId,
    geofences: geofences.map((g) => ({
      event_id: g.event_id,
      title: g.title,
      start_datetime: g.start_datetime,
      end_datetime: g.end_datetime,
      computed_status: g.computed_status,
      points: g.points
    })),
    geofencesFetchedAt: Date.now(),
    sessions,
    pendingExits: { ...keptExits, ...pendingExits }
  });
}

export async function clearBackgroundState() {
  try {
    await AsyncStorage.removeItem(STATE_KEY);
  } catch (e) {
    // ignore
  }
}

async function postNotification(title, body) {
  if (!Notifications || Platform.OS === 'web') return;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Attendance Updates',
        importance: Notifications.AndroidImportance.HIGH
      });
    }
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null
    });
  } catch (e) {
    // Non-fatal -- the attendance itself is already recorded.
  }
}

// Whether any known event is still running or yet to start -- once none is,
// there's nothing left to track and the foreground service is stopped.
function hasUpcomingOrActiveEvent(geofences, nowMs = Date.now()) {
  return geofences.some((g) => {
    const end = new Date(String(g.end_datetime || '').replace(' ', 'T')).getTime();
    return Number.isNaN(end) ? g.computed_status !== 'ended' : end >= nowMs;
  });
}

async function resyncSession(state, eventId) {
  try {
    const history = await getMyHistory();
    const today = localDateString();
    const row = (history.data || []).find((a) => a.attendance_date === today && a.event_id === eventId);
    if (row) state.sessions[eventId] = { id: row.id, open: !row.time_out };
  } catch (e) {
    // Retried on a later reading.
  }
}

async function handleReading(loc) {
  const token = await AsyncStorage.getItem('employee_token');
  const state = await readState();
  if (!token || !state.employeeId) {
    await stopBackgroundAttendance();
    return;
  }

  const now = Date.now();
  if (now - state.geofencesFetchedAt > GEOFENCE_REFRESH_MS) {
    try {
      const res = await getGeofences();
      state.geofences = (res.data || []).map((g) => ({
        event_id: g.event_id, title: g.title, start_datetime: g.start_datetime,
        end_datetime: g.end_datetime, computed_status: g.computed_status, points: g.points
      }));
    } catch (e) {
      // Keep using the last list.
    }
    state.geofencesFetchedAt = now;
  }
  if (!hasUpcomingOrActiveEvent(state.geofences, now)) {
    await writeState(state);
    await stopBackgroundAttendance();
    return;
  }

  const { latitude, longitude, accuracy } = loc.coords;
  const observedAt = new Date(loc.timestamp || now).toISOString();
  const mocked = !!loc.mocked;
  await noteReading({ at: loc.timestamp || now, mocked });

  for (const g of state.geofences) {
    if (!g.points || g.points.length < 3 || !isEventActiveNow(g, now)) continue;
    const eventId = g.event_id;
    const inside = isInsideGeofence(latitude, longitude, g.points, accuracy);
    const session = state.sessions[eventId];

    if (session?.id && session.open) {
      let exit = state.pendingExits[eventId];
      if (exit && exit.attendanceId !== session.id) exit = null;
      if (!inside && !exit) {
        exit = { attendanceId: session.id, observedAt, latitude, longitude, accuracy, mocked };
        state.pendingExits[eventId] = exit;
        await postNotification('Time-Out Recorded', `You left "${g.title}", so you were automatically timed out. Your total time keeps accumulating if you come back.`);
      }
      if (exit) {
        // Same frozen reading every time until the server confirms, so the
        // time-out lands at the moment they actually left.
        try {
          const result = await sendHeartbeat(exit.attendanceId, exit.latitude, exit.longitude, exit.observedAt, {
            accuracy: exit.accuracy,
            mocked: exit.mocked,
            offlineInsideSeconds: await offlineInsideSeconds(exit.attendanceId, Date.parse(exit.observedAt))
          });
          if (result?.data?.ended) {
            forgetTrail(exit.attendanceId);
            delete state.pendingExits[eventId];
            state.sessions[eventId] = { ...session, open: false };
          }
        } catch (e) {
          // Offline -- retried on the next reading.
        }
      } else if (now - (state.lastSentAt[session.id] || 0) >= KEEPALIVE_MS) {
        state.lastSentAt[session.id] = now;
        try {
          const result = await sendHeartbeat(session.id, latitude, longitude, undefined, {
            accuracy, mocked, offlineInsideSeconds: await offlineInsideSeconds(session.id)
          });
          if (result?.data && !result.data.ended && !result.data.ignored) noteServerHeard(session.id);
          // Closed server-side and not reopened (e.g. Location was off while
          // it heard nothing): the next reading inside times in again.
          if (result?.data?.ended) {
            forgetTrail(session.id);
            state.sessions[eventId] = { ...session, open: false };
          }
          else if (result?.data?.requiresFaceVerification) alertFaceVerificationRequired(session.id, g.title);
        } catch (e) {
          // Offline -- the next keep-alive tries again.
        }
      }
    } else if (inside) {
      if (now - (state.lastFailAt[eventId] || 0) < CHECK_IN_RETRY_MS) continue;
      try {
        const result = await submitAttendance({
          employee_id: state.employeeId,
          device_uid: getDeviceUid(),
          event_id: eventId,
          latitude,
          longitude,
          accuracy,
          ...(mocked ? { mocked: true } : {})
        });
        delete state.lastFailAt[eventId];
        if (result?.data?.id) {
          state.sessions[eventId] = { id: result.data.id, open: true };
          state.lastSentAt[result.data.id] = now;
          noteServerHeard(result.data.id);
          await postNotification(
            'Time-In Recorded',
            result.data.action === 're_time_in' || session?.id
              ? `Welcome back to "${g.title}" — you were automatically timed in again.`
              : `You entered "${g.title}" and were automatically timed in.`
          );
          if (result.data.requiresFaceVerification) alertFaceVerificationRequired(result.data.id, g.title);
        }
      } catch (err) {
        state.lastFailAt[eventId] = now;
        // Already open on the server (e.g. the app timed in just before it
        // was closed): pick up that record instead of retrying.
        if (err?.response?.status === 409) await resyncSession(state, eventId);
      }
    }
  }

  await writeState(state);
}

let handling = false;
TaskManager.defineTask(BACKGROUND_ATTENDANCE_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  // The open app's own tracker is in charge while it's on screen.
  if (AppState.currentState === 'active') return;
  // Readings arrive every few seconds; one still being sent is enough.
  if (handling) return;
  handling = true;
  try {
    await handleReading(data.locations[data.locations.length - 1]);
  } catch (e) {
    // Never let one bad reading stop the task.
  } finally {
    handling = false;
  }
});

// Whether "Allow all the time" is granted; asks only when `ask` is true.
export async function ensureBackgroundPermission(ask) {
  if (Platform.OS === 'web') return false;
  try {
    let perm = await Location.getBackgroundPermissionsAsync();
    if (!perm.granted && ask && perm.canAskAgain) perm = await Location.requestBackgroundPermissionsAsync();
    return perm.granted;
  } catch (e) {
    return false;
  }
}

// Returns false without permission or in Expo Go.
export async function startBackgroundAttendance() {
  if (Platform.OS === 'web') return false;
  try {
    if (!(await ensureBackgroundPermission(false))) return false;
    if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_ATTENDANCE_TASK)) return true;
    await Location.startLocationUpdatesAsync(BACKGROUND_ATTENDANCE_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 3000,
      distanceInterval: 0,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      activityType: Location.ActivityType.Other,
      foregroundService: {
        notificationTitle: 'GeoAttend is tracking your attendance',
        notificationBody: 'Your attendance keeps running while you stay inside the event area, even with the app closed.',
        notificationColor: '#0B3D91',
        killServiceOnDestroy: false
      }
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function stopBackgroundAttendance() {
  if (Platform.OS === 'web') return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_ATTENDANCE_TASK)) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_ATTENDANCE_TASK);
    }
  } catch (e) {
    // Not running / not available here.
  }
}
