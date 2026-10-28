import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Animated, Easing, ScrollView } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow } from '../theme';
import FadeIn from '../components/FadeIn';

const POLL_INTERVAL_MS = 8000;

// Polls device status; RootNavigator leaves this screen once approved.
export default function WaitingApprovalScreen() {
  const { employee, refreshDeviceStatus, logout } = useAuth();
  const [checking, setChecking] = useState(false);
  const intervalRef = useRef(null);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const poll = async () => {
      setChecking(true);
      await refreshDeviceStatus();
      setChecking(false);
    };
    poll(); // check immediately on mount, then on an interval
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Slow expanding "radar" ring behind the spinner — reinforces that the app
  // is actively, continuously waiting rather than stuck.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.35, 0.12, 0] });

  // Scrolls so the card still fits on a phone held in landscape.
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <FadeIn>
        <View style={styles.card}>
          <View style={styles.iconCircle}>
            <Animated.View style={[styles.pulseRing, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />
            <ActivityIndicator size="large" color={colors.waitingText} />
          </View>
          <Text style={styles.title}>Waiting for Approval</Text>
          <Text style={styles.body}>
            Your device has been registered{employee ? ` for ${employee.full_name}` : ''} and is
            pending admin approval. Once your administrator approves this device, you'll be taken
            to your Home screen automatically — no need to reopen the app.
          </Text>
          <Text style={styles.hint}>{checking ? 'Checking status…' : 'We\u2019ll keep checking automatically.'}</Text>
        </View>

        <TouchableOpacity style={styles.logoutBtn} onPress={logout}>
          <Text style={styles.logoutBtnText}>Sign out</Text>
        </TouchableOpacity>
      </FadeIn>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 28,
    borderWidth: 1, borderColor: colors.border, ...shadow, alignItems: 'center', maxWidth: 420, width: '100%',
  },
  iconCircle: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: colors.waitingBg,
    alignItems: 'center', justifyContent: 'center', marginBottom: 18,
  },
  pulseRing: {
    position: 'absolute', width: 72, height: 72, borderRadius: 36,
    backgroundColor: colors.waitingText,
  },
  title: { fontSize: 20, fontWeight: '800', color: colors.cspcBlue, marginBottom: 10, textAlign: 'center' },
  body: { fontSize: 13, color: colors.textSub, lineHeight: 19, textAlign: 'center' },
  hint: { fontSize: 11, color: colors.waitingText, fontWeight: '700', marginTop: 18, textAlign: 'center' },
  logoutBtn: { padding: 14, marginTop: 24, alignItems: 'center' },
  logoutBtnText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
});
