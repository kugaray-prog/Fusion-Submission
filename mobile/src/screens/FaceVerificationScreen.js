import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing, ScrollView } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { livenessFailureMessage, livenessCaption, wait } from '../utils/faceCapture';
import LiveFaceCamera, { discardCapture } from '../components/LiveFaceCamera';
import { colors, radius, shadow } from '../theme';
import { verifyAttendanceFace, getMyHistory } from '../api/client';
import { useAttendanceTracking } from '../context/AttendanceTrackingContext';
import AppHeader from '../components/AppHeader';
import { clearFaceVerificationAlert } from '../utils/faceVerificationAlert';
import { useResponsive, MAX_WIDTH } from '../utils/responsive';

// Opened automatically when a geo-anomaly flags a record. Only a server-side
// match (attendanceController.faceVerify) clears the flag.
const DETECTION_ATTEMPTS = 3;

const formatTime = (value) => (value
  ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  : '');

export default function FaceVerificationScreen({ route, navigation }) {
  const { attendanceId, eventTitle } = route.params || {};
  const { clearPendingVerification, refreshAfterVerification } = useAttendanceTracking();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const verifyingRef = useRef(false);
  const startedRef = useRef(false);

  // 'idle' | 'scanning' | 'blink' | 'uploading' | 'success' | 'failed'
  const { isTablet, isCompactHeight, topPad, insets, contentStyle } = useResponsive();
  const [stage, setStage] = useState('idle');
  // Latest per-frame status from the live camera (drives the caption).
  const [live, setLive] = useState({ phase: 'hold', faceDetected: false, hint: null, eyesClosed: false });
  const [errorMsg, setErrorMsg] = useState('');
  // Event of the flagged record, filled in from history.
  const [eventInfo, setEventInfo] = useState(eventTitle ? { title: eventTitle } : null);

  // Verification is closed once the event ends (the server answers 410), so
  // the screen closes itself instead of showing a capture that can't count.
  const closedRef = useRef(false);
  const closeScreen = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    verifyingRef.current = false;
    cameraRef.current?.cancel();
    clearFaceVerificationAlert(attendanceId);
    clearPendingVerification?.(attendanceId);
    refreshAfterVerification?.();
    navigation.replace('Dashboard');
  };

  useEffect(() => {
    if (!attendanceId) return undefined;
    let cancelled = false;
    getMyHistory()
      .then((history) => {
        const record = (history?.data || []).find((a) => String(a.id) === String(attendanceId));
        if (cancelled || !record) return;
        if (!record.requires_face_verification
          || (record.event_end && new Date(record.event_end) <= new Date())) {
          closeScreen();
          return;
        }
        setEventInfo({
          title: record.event_title || eventTitle,
          venue: record.event_venue,
          start: record.event_start,
          end: record.event_end,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [attendanceId, eventTitle]);

  // Event ends while this screen is open: close it right at the end time.
  useEffect(() => {
    if (!eventInfo?.end) return undefined;
    const msLeft = new Date(eventInfo.end).getTime() - Date.now();
    if (Number.isNaN(msLeft)) return undefined;
    if (msLeft <= 0) { closeScreen(); return undefined; }
    const timer = setTimeout(closeScreen, Math.min(msLeft, 2147483647));
    return () => clearTimeout(timer);
  }, [eventInfo?.end]);

  const scanPulse = useRef(new Animated.Value(0)).current;

  // Get location during the scan so it doesn't delay the upload.
  const locationRef = useRef(null);
  useEffect(() => {
    locationRef.current = Location.getLastKnownPositionAsync({ maxAge: 60000 })
      .then((loc) => loc || Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }))
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (permission && !permission.granted) requestPermission();
  }, [permission]);

  // Start the scan as soon as the camera is ready.
  const handleCameraReady = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    runVerification();
  };

  useEffect(() => () => {
    verifyingRef.current = false;
    cameraRef.current?.cancel();
  }, []);

  const handleLiveStatus = (s) => {
    if (!verifyingRef.current) return;
    setLive(s);
    setStage(s.phase === 'blink' ? 'blink' : 'scanning');
  };

  useEffect(() => {
    if (stage !== 'scanning' && stage !== 'blink') return undefined;
    scanPulse.setValue(0);
    const loop = Animated.loop(
      Animated.timing(scanPulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.ease), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [stage, scanPulse]);

  const runVerification = async () => {
    if (verifyingRef.current) return;
    if (!cameraRef.current) {
      setStage('failed');
      setErrorMsg('The camera is not ready yet. Please try again.');
      return;
    }
    setErrorMsg('');
    setLive({ phase: 'hold', faceDetected: false, hint: null, eyesClosed: false });
    verifyingRef.current = true;

    let result = { ok: false, reason: 'no-face' };
    for (let i = 0; i < DETECTION_ATTEMPTS && !result.ok; i++) {
      if (!verifyingRef.current || !cameraRef.current) return;
      setStage('scanning');
      result = await cameraRef.current.runLiveness();
      if (result.reason === 'cancelled' || !verifyingRef.current) {
        discardCapture(result);
        return;
      }
      if (!result.ok && i < DETECTION_ATTEMPTS - 1) await wait(400);
    }

    if (!result.ok) {
      verifyingRef.current = false;
      setStage('failed');
      setErrorMsg(livenessFailureMessage(result.reason));
      return;
    }

    // The selfie still is grabbed the instant the blink completes (eyes
    // open, facing the camera); the video selfie covers the whole check.
    setStage('uploading');
    try {
      // Location is optional; wait at most briefly.
      const [loc, videoUri] = await Promise.all([
        Promise.race([locationRef.current || Promise.resolve(null), wait(1500).then(() => null)]),
        result.video,
      ]);
      const latitude = loc?.coords?.latitude;
      const longitude = loc?.coords?.longitude;

      const formData = new FormData();
      formData.append('selfie', { uri: result.photoUri, name: 'verify.jpg', type: 'image/jpeg' });
      if (videoUri) formData.append('video', { uri: videoUri, name: 'verify.mp4', type: 'video/mp4' });
      formData.append('liveness_verified', 'true');
      formData.append('liveness_actions', 'hold,blink');
      if (latitude != null) formData.append('latitude', String(latitude));
      if (longitude != null) formData.append('longitude', String(longitude));

      const response = await verifyAttendanceFace(attendanceId, formData);
      verifyingRef.current = false;

      if (response?.success) {
        setStage('success');
        refreshAfterVerification?.();
        setTimeout(() => {
          clearPendingVerification?.(attendanceId);
          navigation.replace('Dashboard');
        }, 700);
      } else {
        setStage('failed');
        setErrorMsg(response?.message || 'Verification failed. Please try again.');
      }
    } catch (err) {
      verifyingRef.current = false;
      if (err?.response?.status === 410 || err?.response?.data?.result === 'expired') {
        closeScreen();
        return;
      }
      setStage('failed');
      setErrorMsg(err?.response?.data?.message || "Couldn't verify your face. Please check your connection and try again.");
    } finally {
      discardCapture(result);
    }
  };

  // Cancelling leaves the record flagged; the prompt returns on the next refresh.
  const handleCancel = () => {
    verifyingRef.current = false;
    cameraRef.current?.cancel();
    clearPendingVerification?.(attendanceId);
    navigation.replace('Dashboard');
  };

  const ringScale = scanPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] });
  const ringOpacity = scanPulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.5, 0.15, 0] });

  let caption = 'Preparing camera…';
  if (stage === 'scanning' || stage === 'blink') caption = livenessCaption(live);
  else if (stage === 'uploading') caption = 'Verifying…';
  else if (stage === 'success') caption = 'Verified! Your attendance is confirmed.';
  else if (stage === 'failed') caption = errorMsg || 'Verification failed.';

  // Camera frame (and the face guide inside it) sized to the screen: shorter
  // on a phone held in landscape, taller on a tablet.
  const cameraHeight = isCompactHeight ? 260 : isTablet ? 440 : 340;
  const ovalScale = cameraHeight / 340;
  const ovalSize = { width: 190 * ovalScale, height: 250 * ovalScale, borderRadius: 125 * ovalScale };

  return (
    <ScrollView style={styles.flex} contentContainerStyle={[contentStyle(MAX_WIDTH.form), { paddingTop: topPad, paddingBottom: insets.bottom }]}>
      <AppHeader title="Face Verification" />

      <View style={styles.eventCard}>
        <View style={styles.eventIcon}>
          <Ionicons name="calendar" size={20} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.eventLabel}>EVENT</Text>
          <Text style={styles.eventTitle} numberOfLines={2}>{eventInfo?.title || 'Loading event…'}</Text>
          {!!eventInfo?.venue && (
            <Text style={styles.eventMeta} numberOfLines={1}>
              <Ionicons name="location-outline" size={12} color={colors.textSub} /> {eventInfo.venue}
            </Text>
          )}
          {!!eventInfo?.start && (
            <Text style={styles.eventMeta}>
              <Ionicons name="time-outline" size={12} color={colors.textSub} /> {formatTime(eventInfo.start)}{eventInfo.end ? ` – ${formatTime(eventInfo.end)}` : ''}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.alertCard}>
        <Ionicons name="alert-circle" size={20} color={colors.warning} />
        <Text style={styles.alertText}>
          Your phone was at the same spot as another employee's phone{eventInfo?.title ? ` during "${eventInfo.title}"` : ''}. Please verify it's really you to confirm your attendance.
        </Text>
      </View>

      <View style={[styles.cameraWrap, { height: cameraHeight }]}>
        {permission?.granted ? (
          <LiveFaceCamera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            onReady={handleCameraReady}
            onStatus={handleLiveStatus}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.permissionFallback]}>
            <Ionicons name="camera-outline" size={40} color="#fff" />
            <Text style={styles.permissionText}>Camera access is needed to verify your identity.</Text>
            <TouchableOpacity style={styles.permissionBtn} onPress={requestPermission}>
              <Text style={styles.permissionBtnText}>Grant Camera Access</Text>
            </TouchableOpacity>
          </View>
        )}

        {(stage === 'scanning' || stage === 'blink') && (
          <Animated.View style={[styles.pulseRing, ovalSize, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />
        )}
        <View style={[styles.guideOval, ovalSize]} pointerEvents="none" />

        {stage === 'success' && (
          <View style={[StyleSheet.absoluteFill, styles.resultOverlay, { backgroundColor: 'rgba(5,205,153,0.85)' }]}>
            <Ionicons name="checkmark-circle" size={64} color="#fff" />
          </View>
        )}
        {stage === 'failed' && (
          <View style={[StyleSheet.absoluteFill, styles.resultOverlay, { backgroundColor: 'rgba(238,93,80,0.85)' }]}>
            <Ionicons name="close-circle" size={64} color="#fff" />
          </View>
        )}
      </View>

      <View style={styles.captionWrap}>
        <Text style={[styles.caption, stage === 'failed' && { color: colors.error }]}>{caption}</Text>
      </View>

      {stage === 'failed' && (
        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.retryBtn} onPress={runVerification} activeOpacity={0.85}>
            <Ionicons name="refresh" size={16} color="#fff" />
            <Text style={styles.retryBtnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {stage !== 'success' && (
        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
          <Text style={styles.cancelBtnText}>Cancel — I'll verify later</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  eventCard: {
    flexDirection: 'row', gap: 12, alignItems: 'center', marginBottom: 10,
    backgroundColor: '#fff', borderRadius: radius.md, padding: 14, ...shadow,
  },
  eventIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  eventLabel: { color: colors.textSub, fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8 },
  eventTitle: { color: colors.textMain, fontSize: 15, fontWeight: '800', marginTop: 2 },
  eventMeta: { color: colors.textSub, fontSize: 12, fontWeight: '600', marginTop: 3 },
  alertCard: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 14,
    backgroundColor: colors.warningBg, borderRadius: radius.md, padding: 14,
  },
  alertText: { flex: 1, color: colors.warningText, fontSize: 12.5, fontWeight: '600', lineHeight: 18 },
  cameraWrap: {
    height: 340, borderRadius: radius.lg, overflow: 'hidden',
    backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', ...shadow,
  },
  permissionFallback: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: '#0B1220' },
  permissionText: { color: '#fff', textAlign: 'center', fontSize: 13, fontWeight: '600' },
  permissionBtn: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 18 },
  permissionBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  guideOval: {
    position: 'absolute', width: 190, height: 250, borderRadius: 125,
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.55)',
  },
  pulseRing: {
    position: 'absolute', width: 190, height: 250, borderRadius: 125,
    borderWidth: 2, borderColor: '#fff',
  },
  resultOverlay: { alignItems: 'center', justifyContent: 'center' },
  captionWrap: { paddingHorizontal: 4, marginTop: 18, alignItems: 'center' },
  caption: { fontSize: 15, fontWeight: '800', color: colors.textMain, textAlign: 'center' },
  actionsRow: { alignItems: 'center', marginTop: 18 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.primary,
    borderRadius: radius.md, paddingVertical: 13, paddingHorizontal: 26, ...shadow, shadowColor: colors.primary, shadowOpacity: 0.3,
  },
  retryBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  cancelBtn: { alignItems: 'center', marginTop: 20, marginBottom: 20 },
  cancelBtnText: { color: colors.textSub, fontWeight: '700', fontSize: 12.5 },
});
