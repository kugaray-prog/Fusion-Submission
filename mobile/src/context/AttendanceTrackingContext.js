import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { AppState, Platform } from 'react-native';
import * as Location from 'expo-location';
import { useAuth } from './AuthContext';
import { useLocationStatus } from './LocationStatusContext';
import { getGeofences, registerDevice, submitAttendance, sendHeartbeat, getMyHistory } from '../api/client';
import { navigationRef } from '../navigation/navigationRef';
import { notify } from '../utils/notify';
import { IS_EXPO_GO } from '../utils/expoGo';
import { getDeviceUid, getDeviceInfo } from '../utils/device';
import { liveDurationSeconds } from '../utils/duration';
import { useLiveUpdates } from '../api/realtime';
import { alertFaceVerificationRequired, clearFaceVerificationAlert } from '../utils/faceVerificationAlert';
import Notifications from '../utils/notificationsModule';
import { distanceToEdgeMeters, distanceMeters, isInsideGeofence, isEventActiveNow, localDateString } from '../utils/geofence';
import {
  saveBackgroundState,
  clearBackgroundState,
  startBackgroundAttendance,
  stopBackgroundAttendance,
  ensureBackgroundPermission
} from '../tasks/backgroundAttendance';
import { noteServerHeard, noteReading, offlineInsideSeconds, forgetTrail, clearTrails } from '../utils/presenceTrail';

// Estimated boundary-crossing time, interpolated by each reading's distance to the edge.
function estimateExitTimeMs(prev, now, points) {
  if (!prev || !(now.at > prev.at) || now.at - prev.at > 30000) return now.at;
  const dIn = distanceToEdgeMeters(prev.latitude, prev.longitude, points);
  const dOut = distanceToEdgeMeters(now.latitude, now.longitude, points);
  if (!(dIn + dOut > 0)) return now.at;
  return Math.round(prev.at + (now.at - prev.at) * (dIn / (dIn + dOut)));
}

// Re-check the last location this often (Android only reports new readings on movement).
const REEVALUATE_MS = 5000;
// After a rejected time-in, wait this long before trying again, instead of
// resending on every GPS reading (every ~1s).
const CHECK_IN_RETRY_MS = 2000;

// Heartbeat while timed in. Above the server's 10 s minimum, below its 30 s silence timeout.
const HEARTBEAT_INTERVAL_MS = 12000;
// Push the live position early when moved this far (at most once per LIVE_POSITION_MIN_MS).
const LIVE_POSITION_MIN_METERS = 3;
const LIVE_POSITION_MIN_MS = 3000;
// How often the list of active event geofences is refreshed, so a
// newly-started event is picked up without an app restart.
const GEOFENCE_POLL_MS = 30000;
// Outside readings needed before treating the employee as exited.
const LOCAL_OUTSIDE_CONFIRM_READINGS = 1;

const AttendanceTrackingContext = createContext(null);

export function AttendanceTrackingProvider({ children }) {
  const { employee, deviceStatus, loading: authLoading } = useAuth();
  const { locationEnabled } = useLocationStatus();
  // Tracking requires an approved device and Location on.
  const trackingEnabled = !!employee && deviceStatus === 'approved' && locationEnabled;

  const [location, setLocation] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [geofences, setGeofences] = useState([]);
  // event_id -> { inside, geofence }
  const [presence, setPresence] = useState({});
  // event_id -> today's attendance record (restored from the server on mount).
  const [sessions, setSessions] = useState({});
  const [autoSubmitting, setAutoSubmitting] = useState({}); // event_id -> bool, guards against double-submits
  // event_id -> reason the last auto time-in was rejected.
  const [checkInErrors, setCheckInErrors] = useState({});

  const watchRef = useRef(null);
  const heartbeatTimers = useRef({}); // attendanceId -> interval
  const heartbeatTicks = useRef({}); // attendanceId -> that session's heartbeat function
  const heartbeatInFlight = useRef({}); // attendanceId -> true while a ping is awaiting the server
  const heartbeatRerun = useRef({}); // attendanceId -> true when a ping was requested while one was in flight
  const lastSentPositionRef = useRef({}); // attendanceId -> { latitude, longitude, at } last sent to the server
  const locationRef = useRef(null);
  const lastInsideRef = useRef({}); // event_id -> last GPS reading inside its geofence { latitude, longitude, at }
  // Android's mock-location flag for the latest reading (Fake GPS apps set
  // it); sent with every time-in and heartbeat so the server can refuse it.
  const mockedRef = useRef(false);
  const lastCheckInFailureRef = useRef({}); // event_id -> ms of the last rejected time-in
  // attendanceId -> true once Face Verification was opened this app session.
  const promptedVerificationRef = useRef({});

  const goToFaceVerification = useCallback((attendanceId, eventTitle) => {
    if (!attendanceId) return;
    // Sound + vibration so an employee with the phone in their pocket still
    // notices; throttled internally, so it repeats while still flagged.
    alertFaceVerificationRequired(attendanceId, eventTitle);
    if (promptedVerificationRef.current[attendanceId]) return;
    // FaceVerification isn't registered until past WaitingApproval/WifiCheck; defer until it is.
    const routeNames = navigationRef.isReady() ? navigationRef.getRootState()?.routeNames : null;
    if (!routeNames || !routeNames.includes('FaceVerification')) {
      pendingVerificationNavRef.current = { attendanceId, eventTitle };
      return;
    }
    pendingVerificationNavRef.current = null;
    promptedVerificationRef.current[attendanceId] = true;
    navigationRef.navigate('FaceVerification', { attendanceId, eventTitle });
  }, []);
  // A flagged record waiting for the FaceVerification screen to become
  // available -- { attendanceId, eventTitle } or null.
  const pendingVerificationNavRef = useRef(null);
  useEffect(() => {
    const unsubscribe = navigationRef.addListener('state', () => {
      const pending = pendingVerificationNavRef.current;
      if (!pending) return;
      // Deferred so it doesn't navigate in the middle of the navigator's
      // own screen-list swap.
      setTimeout(() => goToFaceVerification(pending.attendanceId, pending.eventTitle), 0);
    });
    return unsubscribe;
  }, [goToFaceVerification]);
  const sessionsRef = useRef({});
  const geofencesRef = useRef([]);
  const autoSubmittingRef = useRef({});
  const localOutsideStreakRef = useRef({}); // event_id -> consecutive local "outside" GPS readings while a session is open
  // event_id -> { attendanceId, observedAt, latitude, longitude } of an exit not yet
  // acknowledged by the server; heartbeats resend this exact reading.
  const pendingExitRef = useRef({});

  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { geofencesRef.current = geofences; }, [geofences]);
  useEffect(() => { autoSubmittingRef.current = autoSubmitting; }, [autoSubmitting]);

  const deviceUid = useCallback(() => getDeviceUid(), []);

  const stopHeartbeat = (attendanceId) => {
    if (heartbeatTimers.current[attendanceId]) {
      clearInterval(heartbeatTimers.current[attendanceId]);
      delete heartbeatTimers.current[attendanceId];
      delete heartbeatTicks.current[attendanceId];
      delete heartbeatRerun.current[attendanceId];
    }
  };

  // Heartbeat for an open session, independent of the focused screen. Resends a
  // pending exit reading until the server confirms the time-out.
  const startHeartbeat = useCallback((eventId, attendanceId) => {
    stopHeartbeat(attendanceId);
    const tick = async () => {
      if (heartbeatInFlight.current[attendanceId]) {
        // A ping is in flight: rerun right after it.
        heartbeatRerun.current[attendanceId] = true;
        return;
      }
      heartbeatInFlight.current[attendanceId] = true;
      const pending = pendingExitRef.current[eventId];
      const usingPending = pending && pending.attendanceId === attendanceId;
      const coords = usingPending
        ? { latitude: pending.latitude, longitude: pending.longitude, accuracy: pending.accuracy }
        : locationRef.current;
      if (!coords && !(usingPending && pending.locationOff)) {
        delete heartbeatInFlight.current[attendanceId];
        return;
      }
      if (!usingPending && coords) lastSentPositionRef.current[attendanceId] = { ...coords, at: Date.now() };
      try {
        const result = await sendHeartbeat(
          attendanceId,
          coords?.latitude,
          coords?.longitude,
          usingPending ? pending.observedAt : undefined,
          {
            accuracy: coords?.accuracy,
            mocked: usingPending ? pending.mocked : mockedRef.current,
            locationOff: usingPending && pending.locationOff,
            offlineInsideSeconds: await offlineInsideSeconds(attendanceId, usingPending ? Date.parse(pending.observedAt) : Date.now())
          }
        );
        if (result?.data && !result.data.ended && !result.data.ignored) noteServerHeard(attendanceId);
        if (result?.data?.ended) {
          forgetTrail(attendanceId);
          if (usingPending) delete pendingExitRef.current[eventId];
          stopHeartbeat(attendanceId);
          // Close locally now so re-entry can time in on the next reading.
          const endedAt = usingPending ? pending.observedAt : new Date().toISOString();
          const closeLocally = (all) => {
            const s = all[eventId];
            if (!s || s.id !== attendanceId || s.time_out) return all;
            return { ...all, [eventId]: { ...s, time_out: endedAt, pendingExitAt: s.pendingExitAt || endedAt } };
          };
          sessionsRef.current = closeLocally(sessionsRef.current);
          setSessions(closeLocally);
          await refreshSessionsFromHistoryRef.current?.();
          // A local exit already told the employee when it was detected.
          if (!usingPending) {
            notify('Time-Out Recorded', 'You left the event area, so your session was automatically timed out. Your total time keeps accumulating if you come back.');
          }
        } else if (result?.data?.requiresFaceVerification) {
          // Flagged by the server for face verification: re-sync the paused total.
          if (!sessionsRef.current[eventId]?.requires_face_verification) {
            refreshSessionsFromHistoryRef.current?.();
          }
          const geofence = geofencesRef.current.find((g) => g.event_id === eventId);
          goToFaceVerification(attendanceId, geofence?.title);
        } else if (result?.data && result.data.requiresFaceVerification === false) {
          clearFaceVerificationAlert(attendanceId);
          // Verified -- a later re-flag (still at the same spot as another
          // phone after another 30s) must open the screen again.
          delete promptedVerificationRef.current[attendanceId];
          // Verified elsewhere (e.g. admin-assisted) -- pick up the resumed session.
          if (sessionsRef.current[eventId]?.requires_face_verification) {
            refreshSessionsFromHistoryRef.current?.();
          }
        }
      } catch (e) {
        // Retried on the next tick.
      } finally {
        delete heartbeatInFlight.current[attendanceId];
        if (heartbeatRerun.current[attendanceId]) {
          delete heartbeatRerun.current[attendanceId];
          if (heartbeatTicks.current[attendanceId] === tick) tick();
        }
      }
    };
    heartbeatTicks.current[attendanceId] = tick;
    heartbeatTimers.current[attendanceId] = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  }, [goToFaceVerification]);

  // Send movement immediately instead of waiting for the next heartbeat.
  const pushLivePosition = (coords) => {
    Object.entries(sessionsRef.current).forEach(([eventId, s]) => {
      if (!s?.id || s.time_out || pendingExitRef.current[eventId]) return;
      const tick = heartbeatTicks.current[s.id];
      if (!tick) return;
      const last = lastSentPositionRef.current[s.id];
      if (last) {
        if (Date.now() - last.at < LIVE_POSITION_MIN_MS) return;
        // Ignore movement within the GPS accuracy radius.
        const minMeters = Math.max(LIVE_POSITION_MIN_METERS, Number(coords.accuracy) || 0);
        if (distanceMeters(last.latitude, last.longitude, coords.latitude, coords.longitude) < minMeters) return;
      }
      tick();
    });
  };

  // Restores today's records from the server and resumes heartbeats for open sessions.
  const refreshSessionsFromHistory = useCallback(async () => {
    try {
      let history = await getMyHistory();
      const today = localDateString();
      // Ask the server to undo a time-out made while offline but inside.
      const heldExitFor = (a) => {
        const p = pendingExitRef.current[a.event_id];
        return p && p.attendanceId === a.id ? p : null;
      };
      const resumable = [];
      for (const a of (history.data || []).filter((r) => r.attendance_date === today && r.time_out)) {
        const p = heldExitFor(a);
        const claim = await offlineInsideSeconds(a.id, p ? Date.parse(p.observedAt) : Date.now());
        if (claim) resumable.push({ a, p, claim });
      }
      if (resumable.length) {
        await Promise.all(resumable.map(async ({ a, p, claim }) => {
          const coords = p || locationRef.current;
          try {
            const result = await sendHeartbeat(a.id, coords?.latitude, coords?.longitude, p?.observedAt, {
              accuracy: coords?.accuracy,
              mocked: p ? p.mocked : mockedRef.current,
              locationOff: !!p?.locationOff,
              offlineInsideSeconds: claim
            });
            if (result?.data?.ended) {
              forgetTrail(a.id);
              if (p) delete pendingExitRef.current[a.event_id];
            } else if (result?.data && !result.data.ignored) {
              noteServerHeard(a.id);
            }
          } catch (e) {
            // Still offline -- tried again on the next refresh or heartbeat.
          }
        }));
        history = await getMyHistory();
      }
      const todays = (history.data || []).filter((a) => a.attendance_date === today);
      const map = {};
      todays.forEach((a) => {
        map[a.event_id] = {
          id: a.id,
          time_in: a.time_in,
          time_out: a.time_out,
          total_duration_seconds: a.total_duration_seconds,
          open_session_time_in: a.open_session_time_in,
          session_count: a.session_count,
          // While set, the server has the duration clock stopped until the
          // employee passes face verification.
          requires_face_verification: !!a.requires_face_verification
        };
      });
      // Keep the duration frozen for an exit not yet acknowledged.
      Object.entries(pendingExitRef.current).forEach(([eventId, pending]) => {
        const session = map[eventId];
        if (session && session.id === pending.attendanceId && !session.time_out) {
          session.pendingExitAt = pending.observedAt;
        } else {
          // Either already closed server-side or no longer matches this
          // session — nothing left for this pending reading to do.
          delete pendingExitRef.current[eventId];
        }
      });
      setSessions(map);
      todays.forEach((a) => {
        if (!a.time_out) startHeartbeat(a.event_id, a.id);
      });
      // Re-prompt face verification for a still-flagged record of a running event.
      const eventEnded = (a) => !!a.event_end && new Date(a.event_end) <= new Date();
      const stillFlagged = todays.find((a) => a.requires_face_verification && !eventEnded(a));
      if (stillFlagged) {
        goToFaceVerification(stillFlagged.id, stillFlagged.event_title);
      }
      todays.forEach((a) => {
        if (!a.requires_face_verification || eventEnded(a)) {
          clearFaceVerificationAlert(a.id);
          delete promptedVerificationRef.current[a.id];
        }
      });
    } catch (e) {
      // Non-fatal — worst case auto time-in re-evaluates from a blank slate
      // and the backend's own duplicate check still protects against double entries.
    }
  }, [startHeartbeat, goToFaceVerification]);

  // Ref breaks the startHeartbeat <-> refreshSessionsFromHistory cycle.
  const refreshSessionsFromHistoryRef = useRef(null);
  useEffect(() => { refreshSessionsFromHistoryRef.current = refreshSessionsFromHistory; }, [refreshSessionsFromHistory]);

  const refreshGeofences = useCallback(async () => {
    try {
      const res = await getGeofences();
      setGeofences(res.data || []);
    } catch (e) {
      // Non-fatal — next poll tries again.
    }
  }, []);

  // Auto time-in on entering an active event's geofence (also re-entries).
  const autoCheckIn = useCallback(async (geofence, coords, acc) => {
    const eventId = geofence.event_id;
    if (autoSubmittingRef.current[eventId]) return;
    if (Date.now() - (lastCheckInFailureRef.current[eventId] || 0) < CHECK_IN_RETRY_MS) return;
    // Set synchronously: the state -> ref sync below only lands after a
    // re-render, and a second GPS reading can arrive before that.
    autoSubmittingRef.current = { ...autoSubmittingRef.current, [eventId]: true };
    setAutoSubmitting((prev) => ({ ...prev, [eventId]: true }));
    try {
      const result = await submitAttendance({
        employee_id: employee.id,
        device_uid: deviceUid(),
        event_id: eventId,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: acc,
        ...(mockedRef.current ? { mocked: true } : {})
      });
      delete lastCheckInFailureRef.current[eventId];
      setCheckInErrors((prev) => ({ ...prev, [eventId]: null }));
      if (result?.data?.id) {
        noteServerHeard(result.data.id);
        const nowIso = new Date().toISOString();
        // A flagged time-in has its clock stopped server-side until face
        // verification passes, so it must not start ticking here either.
        const paused = !!result.data.requiresFaceVerification;
        setSessions((prev) => ({
          ...prev,
          [eventId]: {
            ...(prev[eventId] || {}),
            id: result.data.id,
            time_in: prev[eventId]?.time_in || nowIso,
            time_out: null,
            open_session_time_in: paused ? null : nowIso,
            session_count: (prev[eventId]?.session_count || 0) + (paused ? 0 : 1),
            requires_face_verification: paused
          }
        }));
        startHeartbeat(eventId, result.data.id);
        notify(
          result.data.action === 're_time_in' ? 'Time-In Recorded Again' : 'Time-In Recorded',
          result.data.action === 're_time_in'
            ? `Welcome back to "${geofence.title}" — you were automatically timed in again.`
            : `You entered "${geofence.title}" and were automatically timed in.`
        );
        if (result.data.requiresFaceVerification) {
          refreshSessionsFromHistoryRef.current?.();
          goToFaceVerification(result.data.id, geofence.title);
        }
      }
    } catch (err) {
      // Expected rejections retry on the next reading; the reason is shown on the Attendance screen.
      lastCheckInFailureRef.current[eventId] = Date.now();
      if (err?.response?.status === 409) {
        // Server already has an open session: sync instead of retrying.
        await refreshSessionsFromHistoryRef.current?.();
        setCheckInErrors((prev) => ({ ...prev, [eventId]: null }));
        return;
      }
      const message = err?.response?.data?.message
        || (err?.request ? 'Could not reach the server to record your time-in. Retrying…' : 'Time-in failed. Retrying…');
      setCheckInErrors((prev) => ({ ...prev, [eventId]: message }));
    } finally {
      autoSubmittingRef.current = { ...autoSubmittingRef.current, [eventId]: false };
      setAutoSubmitting((prev) => ({ ...prev, [eventId]: false }));
    }
  }, [employee, deviceUid, startHeartbeat, goToFaceVerification]);

  // Checks each reading against active geofences: inside with no open session ->
  // time in; outside with an open session -> freeze the duration and send the exit
  // reading now. `recheck` re-evaluates the last reading without counting toward
  // the outside streak.
  const evaluateLocation = useCallback((coords, acc, observedAtMs, { recheck = false } = {}) => {
    const activeGeofences = geofencesRef.current.filter((g) => isEventActiveNow(g));
    const nextPresence = {};
    activeGeofences.forEach((g) => {
      if (!g.points || g.points.length < 3) return;
      const inside = isInsideGeofence(coords.latitude, coords.longitude, g.points, acc);
      nextPresence[g.event_id] = { inside, geofence: g };
      const readingAt = observedAtMs || Date.now();
      if (inside && !recheck) {
        lastInsideRef.current[g.event_id] = { latitude: coords.latitude, longitude: coords.longitude, at: readingAt };
      }
      const existingSession = sessionsRef.current[g.event_id];
      // A session is already open for today when we have a record with no
      // time_out — that's the only case where we should NOT re-check-in.
      const hasOpenSession = existingSession && existingSession.id && !existingSession.time_out;
      if (inside && !hasOpenSession) {
        autoCheckIn(g, coords, acc);
      } else if (!inside && hasOpenSession) {
        if (recheck) return;
        const eventId = g.event_id;
        const streak = (localOutsideStreakRef.current[eventId] || 0) + 1;
        localOutsideStreakRef.current[eventId] = streak;
        if (streak >= LOCAL_OUTSIDE_CONFIRM_READINGS && !pendingExitRef.current[eventId]) {
          // The moment they crossed the edge, not just when the first
          // outside reading came in -- but never before this session opened.
          let exitAtMs = estimateExitTimeMs(
            lastInsideRef.current[eventId],
            { latitude: coords.latitude, longitude: coords.longitude, at: readingAt },
            g.points
          );
          const openedAt = new Date(existingSession.open_session_time_in || existingSession.time_in || 0).getTime();
          if (!(exitAtMs >= openedAt)) exitAtMs = readingAt;
          const observedAtIso = new Date(exitAtMs).toISOString();
          pendingExitRef.current[eventId] = {
            attendanceId: existingSession.id,
            observedAt: observedAtIso,
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: acc,
            mocked: mockedRef.current
          };
          setSessions((prev) => ({
            ...prev,
            [eventId]: { ...(prev[eventId] || {}), pendingExitAt: observedAtIso }
          }));
          // Send the exit now instead of on the next heartbeat.
          heartbeatTicks.current[existingSession.id]?.();
          notify('Time-Out Recorded', `You left "${g.title}", so you were automatically timed out. Your total time keeps accumulating if you come back.`);
        }
      } else if (inside) {
        localOutsideStreakRef.current[g.event_id] = 0;
        // pendingExitRef stays until the server acknowledges the exit.
      }
    });
    setPresence(nextPresence);
  }, [autoCheckIn]);

  // Live admin changes; 'attendance' also opens Face Verification as soon as a record is flagged.
  useLiveUpdates(['events', 'geofences', 'attendance'], (topic) => {
    if (!trackingEnabled) return;
    if (topic === 'attendance' || topic === '*') refreshSessionsFromHistory();
    if (topic !== 'attendance') refreshGeofences();
  });

  // Tapping the "Face verification required" notification opens the screen,
  // even if the employee backed out of it earlier this app session.
  useEffect(() => {
    if (!Notifications || !trackingEnabled) return undefined;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response?.notification?.request?.content?.data;
      if (data?.type !== 'face_verification_required' || !data.attendanceId) return;
      delete promptedVerificationRef.current[data.attendanceId];
      goToFaceVerification(data.attendanceId, data.eventTitle);
    });
    return () => sub.remove();
  }, [trackingEnabled, goToFaceVerification]);

  // Back in the foreground: re-sync, so a flag raised while the app was in
  // the background brings up Face Verification as soon as it's opened.
  useEffect(() => {
    if (!trackingEnabled) return undefined;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshSessionsFromHistoryRef.current?.();
    });
    return () => sub.remove();
  }, [trackingEnabled]);

  // Setup: permissions, device registration, history/geofence load, location watch.
  useEffect(() => {
    if (!trackingEnabled) return;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (!cancelled) setPermissionDenied(true);
        return;
      }
      if (!cancelled) setPermissionDenied(false);

      // Start GPS first; readings aren't evaluated until geofences load after sessions are restored.
      try {
        // A reading every second, moving or not, so stepping out of the
        // polygon is noticed within about a second.
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
          (loc) => {
            setLocation(loc.coords);
            locationRef.current = loc.coords;
            mockedRef.current = !!loc.mocked;
            noteReading({ at: loc.timestamp || Date.now(), mocked: !!loc.mocked });
            setAccuracy(loc.coords.accuracy);
            // loc.timestamp is the GPS fix time (valid offline).
            evaluateLocation(loc.coords, loc.coords.accuracy, loc.timestamp);
            pushLivePosition(loc.coords);
          }
        );
        if (cancelled) sub.remove();
        else watchRef.current = sub;
      } catch (e) {
        // GPS turned off meanwhile; LocationGateOverlay handles it.
      }
      if (cancelled) return;

      // Loaded in parallel; geofences are applied only after sessions are restored.
      const device = getDeviceInfo();
      const registering = registerDevice({
        employee_id: employee.id,
        device_uid: device.uid,
        model: device.model,
        brand: device.brand,
        os: device.os
      }).catch(() => {
        // Non-fatal here — submitAttendance will surface a clear "device not
        // registered/approved" message if it turns out to matter.
      });
      const loadingGeofences = getGeofences().catch(() => null);

      await refreshSessionsFromHistory();
      const geofenceRes = await loadingGeofences;
      if (cancelled) return;
      if (geofenceRes) setGeofences(geofenceRes.data || []);
      else await refreshGeofences();
      await registering;
    })();

    const geofencePoll = setInterval(refreshGeofences, GEOFENCE_POLL_MS);
    const reevaluate = setInterval(() => {
      const coords = locationRef.current;
      if (coords) evaluateLocation(coords, coords.accuracy, undefined, { recheck: true });
    }, REEVALUATE_MS);

    return () => {
      cancelled = true;
      if (watchRef.current) watchRef.current.remove();
      watchRef.current = null;
      clearInterval(geofencePoll);
      clearInterval(reevaluate);
      Object.keys(heartbeatTimers.current).forEach(stopHeartbeat);
    };
  }, [trackingEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Location turned off with a session open: freeze it now and tell the server
  // (retried until acknowledged).
  useEffect(() => {
    if (!employee || deviceStatus !== 'approved' || locationEnabled) return;
    const offAt = new Date().toISOString();
    const last = locationRef.current;
    const frozen = {};
    Object.entries(sessionsRef.current).forEach(([eventId, s]) => {
      if (!s?.id || s.time_out) return;
      const existing = pendingExitRef.current[eventId];
      if (existing && existing.attendanceId === s.id) {
        // Already left the geofence earlier -- keep that earlier exit time.
        existing.locationOff = true;
        return;
      }
      pendingExitRef.current[eventId] = {
        attendanceId: s.id,
        observedAt: offAt,
        latitude: last?.latitude,
        longitude: last?.longitude,
        accuracy: last?.accuracy,
        mocked: mockedRef.current,
        locationOff: true
      };
      frozen[eventId] = offAt;
    });
    if (Object.keys(frozen).length) {
      setSessions((prev) => {
        const next = { ...prev };
        Object.entries(frozen).forEach(([eventId, at]) => {
          next[eventId] = { ...(next[eventId] || {}), pendingExitAt: at };
        });
        return next;
      });
    }

    let stopped = false;
    const flush = async () => {
      let anyEnded = false;
      for (const [eventId, pending] of Object.entries(pendingExitRef.current)) {
        if (stopped || !pending.locationOff) continue;
        try {
          const result = await sendHeartbeat(pending.attendanceId, pending.latitude, pending.longitude, pending.observedAt, {
            accuracy: pending.accuracy,
            mocked: pending.mocked,
            locationOff: true,
            offlineInsideSeconds: await offlineInsideSeconds(pending.attendanceId, Date.parse(pending.observedAt))
          });
          if (result?.data?.ended) {
            forgetTrail(pending.attendanceId);
            delete pendingExitRef.current[eventId];
            anyEnded = true;
          }
        } catch (e) {
          // No connectivity -- retried on the next tick (or by the heartbeat
          // once Location is back on), still with the original off time.
        }
      }
      if (anyEnded && !stopped) {
        await refreshSessionsFromHistoryRef.current?.();
        notify('Time-Out Recorded', 'Your Location was turned off, so your session was timed out. Turn Location back on to continue your attendance.');
      }
    };
    flush();
    const retry = setInterval(flush, HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(retry);
    };
  }, [locationEnabled, employee, deviceStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hand state off to the background task (tasks/backgroundAttendance.js).
  useEffect(() => {
    if (!employee || deviceStatus !== 'approved') return;
    const bgSessions = {};
    Object.entries(sessions).forEach(([eventId, s]) => {
      if (s?.id) bgSessions[eventId] = { id: s.id, open: !s.time_out };
    });
    const bgExits = {};
    Object.entries(pendingExitRef.current).forEach(([eventId, p]) => {
      if (p.locationOff) return; // the server is told about these directly
      bgExits[eventId] = {
        attendanceId: p.attendanceId, observedAt: p.observedAt,
        latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, mocked: p.mocked
      };
    });
    saveBackgroundState({ employeeId: employee.id, geofences, sessions: bgSessions, pendingExits: bgExits });
  }, [employee, deviceStatus, geofences, sessions]);

  // Run the background task while there's an event to track or a session open.
  // Asks for "Allow all the time" once per launch.
  const askedBackgroundRef = useRef(false);
  useEffect(() => {
    // Still restoring the signed-in employee: don't mistake that for a sign-out.
    if (authLoading) return;
    if (!employee || deviceStatus !== 'approved') {
      stopBackgroundAttendance();
      clearBackgroundState();
      clearTrails();
      return;
    }
    if (!trackingEnabled) return; // Location off: left as is, it resumes when Location is back
    const needed = geofences.length > 0 || Object.values(sessions).some((s) => s?.id && !s.time_out);
    if (!needed) return;
    let cancelled = false;
    (async () => {
      if (await startBackgroundAttendance()) return;
      if (cancelled || askedBackgroundRef.current || Platform.OS === 'web') return;
      askedBackgroundRef.current = true;
      // Expo Go has no background location on Android, so there's nothing
      // to grant: say so, rather than let a silence time-out come as a surprise.
      if (IS_EXPO_GO) {
        notify(
          'Attendance stops when you leave the app',
          "Expo Go can't track your location in the background, so your attendance only runs while GeoAttend is on screen. Install the GeoAttend app to keep it running while you stay inside the event area."
        );
        return;
      }
      notify(
        'Keep attendance running when the app is closed',
        'To keep your attendance running after you close GeoAttend -- and time you out as soon as you leave the event area -- set Location to "Allow all the time" on the next screen.',
        [
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Continue',
            onPress: async () => {
              if (await ensureBackgroundPermission(true)) startBackgroundAttendance();
            }
          }
        ]
      );
    })();
    return () => { cancelled = true; };
  }, [authLoading, employee, deviceStatus, trackingEnabled, geofences, sessions]);

  // Re-evaluate presence whenever the geofence list itself changes (e.g. a
  // new event just went active), using the last known location.
  useEffect(() => {
    if (locationRef.current) evaluateLocation(locationRef.current, locationRef.current.accuracy, undefined, { recheck: true });
  }, [geofences]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = {
    location,
    accuracy,
    permissionDenied,
    geofences,
    presence, // event_id -> { inside, geofence }
    sessions, // event_id -> { id, time_in, time_out, total_duration_seconds, open_session_time_in, session_count, requires_face_verification }
    checkInErrors, // event_id -> last server rejection message for auto time-in, or null
    // Live duration in seconds across today's sessions.
    getDurationSeconds: (eventId) => liveDurationSeconds(sessions[eventId]),
    refreshGeofences,
    refreshSessionsFromHistory,
    refreshAfterVerification: refreshSessionsFromHistory,
    // Lets the next history refresh prompt again after a cancel.
    clearPendingVerification: (attendanceId) => {
      if (attendanceId) delete promptedVerificationRef.current[attendanceId];
    }
  };

  return (
    <AttendanceTrackingContext.Provider value={value}>
      {children}
    </AttendanceTrackingContext.Provider>
  );
}

export const useAttendanceTracking = () => useContext(AttendanceTrackingContext);
