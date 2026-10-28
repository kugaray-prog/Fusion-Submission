import React, { useEffect, useMemo, useState, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAttendanceTracking } from '../context/AttendanceTrackingContext';
import { colors, radius, shadow } from '../theme';
import { formatDuration } from '../utils/duration';
import FadeIn from '../components/FadeIn';
import AppHeader from '../components/AppHeader';
import { useResponsive, MAX_WIDTH } from '../utils/responsive';

// Read-only view of automatic tracking (AttendanceTrackingContext).
export default function AttendanceScreen({ route }) {
  const tracking = useAttendanceTracking();
  const geofenceId = route?.params?.geofenceId ?? null;
  const [, forceTick] = useState(0);
  const { insets, contentStyle } = useResponsive();

  // Re-render once a second so the "on-going" duration visibly counts up
  // instead of only updating whenever a new location/heartbeat happens to land.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const geofence = useMemo(
    () => (tracking?.geofences || []).find((g) => g.id === geofenceId) || null,
    [tracking?.geofences, geofenceId]
  );
  const eventId = geofence?.event_id;
  const presence = eventId != null ? tracking?.presence?.[eventId] : null;
  const session = eventId != null ? tracking?.sessions?.[eventId] : null;

  const isInside = !!presence?.inside;
  // Awaiting face verification: the server stopped the clock until it passes.
  const isPaused = !!session?.id && !!session?.requires_face_verification;
  // pendingExitAt: the phone saw them leave the polygon -- show it as timed
  // out right away instead of waiting for the server to confirm.
  const isOpen = !!session?.id && !session?.time_out && !session?.pendingExitAt && !isPaused;
  const hasAnySession = !!session?.id;
  const durationSeconds = eventId != null ? tracking?.getDurationSeconds?.(eventId) || 0 : 0;
  const sessionCount = session?.session_count || 0;

  const checkInError = eventId != null ? tracking?.checkInErrors?.[eventId] : null;
  // presence exists as soon as the tracker sees the event as started, which
  // can be up to one geofence poll before computed_status catches up.
  const eventActive = geofence?.computed_status === 'active' || !!presence;

  // No presence data means not started or no GPS fix yet, not "outside".
  let statusLabel = 'Checking your location…';
  if (!geofence) statusLabel = 'This event is no longer available.';
  else if (isPaused) statusLabel = 'Time paused — complete face verification to resume recording.';
  else if (isOpen) statusLabel = `You are inside "${geofence.title}" — time is being recorded.`;
  else if (!eventActive) statusLabel = `"${geofence.title}" hasn't started yet — attendance opens at ${new Date(geofence.start_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  else if (!presence) statusLabel = 'Checking your location…';
  else if (isInside) statusLabel = 'Inside the geofence — timing in…';
  else statusLabel = `Outside the "${geofence.title}" geofence boundary.`;

  const statusIsGood = !isPaused && (isInside || isOpen);
  const statusIsNeutral = !statusIsGood && (!eventActive || !presence);

  // Soft pulsing "recording" dot next to the status line while a session is
  // actively open — a quick, ambient confirmation that time is ticking.
  const livePulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isOpen) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(livePulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isOpen, livePulse]);
  const dotOpacity = livePulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });

  return (
    <ScrollView style={styles.container} contentContainerStyle={[contentStyle(MAX_WIDTH.form), { paddingTop: 20, paddingBottom: 20 + insets.bottom }]}>
      <AppHeader title="Mark Attendance" />
      <FadeIn>
        <View style={[styles.statusCard, { backgroundColor: statusIsGood ? colors.successBg : statusIsNeutral ? colors.infoBg : '#FEE2E2' }]}>
          <View style={styles.statusRow}>
            {isOpen && <Animated.View style={[styles.liveDot, { opacity: dotOpacity }]} />}
            <Text style={[styles.statusText, { color: statusIsGood ? colors.success : statusIsNeutral ? colors.infoText : colors.error }]}>{statusLabel}</Text>
          </View>
          {!isOpen && isInside && !!checkInError && <Text style={styles.checkInErrorText}>{checkInError}</Text>}
          {tracking?.accuracy != null && <Text style={styles.accuracyText}>GPS accuracy: {Math.round(tracking.accuracy)}m</Text>}
        </View>
      </FadeIn>

      {geofence && (
        <FadeIn delay={60}>
          <View style={styles.eventCard}>
            <Text style={styles.eventTitle}>{geofence.title}</Text>
            <View style={styles.venueRow}>
              <Ionicons name="location-outline" size={14} color={colors.textSub} />
              <Text style={styles.eventVenue}>{geofence.venue || 'Venue TBA'}</Text>
            </View>
          </View>
        </FadeIn>
      )}

      <FadeIn delay={120}>
        <View style={styles.durationCard}>
          <Text style={styles.durationLabel}>{isPaused ? 'Paused — verify your face to resume' : isOpen ? 'On-going — total time today' : 'Total time recorded today'}</Text>
          <Text style={styles.durationValue}>{formatDuration(durationSeconds)}</Text>
          {sessionCount > 1 && (
            <Text style={styles.sessionCountText}>Across {sessionCount} time-in/time-out sessions</Text>
          )}
        </View>
      </FadeIn>

      <FadeIn delay={180}>
        <View style={styles.infoCard}>
          <Text style={styles.infoText}>
            {hasAnySession
              ? 'Attendance is automatic — leaving and re-entering the event area will keep timing you in and out, and your total time keeps adding up until the event ends.'
              : 'Attendance is automatic — walk into the event area and you\'ll be timed in without needing to tap anything.'}
          </Text>
        </View>
      </FadeIn>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  statusCard: { borderRadius: radius.md, padding: 18, marginBottom: 14 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  statusText: { fontWeight: '700', fontSize: 14, flexShrink: 1, lineHeight: 20 },
  checkInErrorText: { color: colors.error, fontSize: 12, marginTop: 8, fontWeight: '600' },
  accuracyText: { color: colors.textMain, fontSize: 12, marginTop: 6 },
  eventCard: { backgroundColor: colors.white, borderRadius: radius.md, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: colors.border, ...shadow },
  eventTitle: { fontWeight: '700', color: colors.textMain, fontSize: 17, letterSpacing: -0.2 },
  venueRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  eventVenue: { color: colors.textSub, fontSize: 13, fontWeight: '500' },
  durationCard: {
    backgroundColor: colors.primary, borderRadius: radius.md, padding: 22, marginBottom: 14,
    alignItems: 'center', ...shadow, shadowColor: colors.primary, shadowOpacity: 0.3,
  },
  durationLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  durationValue: { color: '#fff', fontSize: 38, fontWeight: '700', marginTop: 8, letterSpacing: -0.5 },
  sessionCountText: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '600', marginTop: 8 },
  infoCard: { backgroundColor: colors.successBg, borderRadius: radius.md, padding: 14, marginBottom: 14 },
  infoText: { color: colors.success, fontSize: 12, fontWeight: '600' },
});
