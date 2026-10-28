import React, { useEffect } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useAuth } from '../context/AuthContext';
import { useLocationStatus } from '../context/LocationStatusContext';
import { colors, radius, shadow } from '../theme';
import { MODAL_ORIENTATIONS } from '../utils/responsive';
import { alertServiceOff, clearServiceOffAlert } from '../utils/serviceOffAlert';

// Blocks the whole app while signed in and Location is off.
export default function LocationGateOverlay() {
  const { employee, deviceStatus } = useAuth();
  const { locationEnabled, checked, recheck } = useLocationStatus();
  // Not while the device is still awaiting approval (see WifiGateOverlay).
  const visible = !!employee && deviceStatus !== 'pending' && checked && !locationEnabled;

  // Also post a phone notification while this is showing (see serviceOffAlert).
  useEffect(() => {
    if (visible) alertServiceOff('location');
    else clearServiceOffAlert('location');
  }, [visible]);

  if (!visible) return null;

  const openLocationSettings = async () => {
    try {
      if (Platform.OS === 'android') {
        // Shows the system "Turn on Location" prompt directly, without
        // leaving the app -- Android-only API.
        await Location.enableNetworkProviderAsync();
        recheck();
        return;
      }
    } catch (e) {
      // The employee dismissed the system prompt, or it's unsupported on
      // this device -- fall through to opening Settings directly instead.
    }
    try {
      if (Platform.OS === 'ios') {
        await Linking.openURL('app-settings:');
      } else {
        await Linking.openSettings();
      }
    } catch (e) {
    }
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent supportedOrientations={MODAL_ORIENTATIONS} onRequestClose={() => {}}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="location-outline" size={38} color={colors.error} />
          </View>
          <Text style={styles.title}>Please turn on your Location/GPS.</Text>
          <Text style={styles.subtitle}>
            GeoAttend needs your device's Location/GPS turned on to verify your attendance and track your presence at the event area. Location-dependent features are unavailable until it's turned back on.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={openLocationSettings}>
            <Text style={styles.btnText}>Turn On Location</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnOutline} onPress={recheck}>
            <Text style={styles.btnOutlineText}>I've turned it on — Recheck</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.75)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, padding: 26, width: '100%', maxWidth: 360, alignItems: 'center', ...shadow },
  iconWrap: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.dangerBg, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 17, fontWeight: '800', color: colors.cspcBlue, textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 13, color: colors.textSub, textAlign: 'center', lineHeight: 19, marginBottom: 22 },
  btn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', width: '100%', ...shadow, shadowColor: colors.primary, shadowOpacity: 0.3 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  btnOutline: { paddingVertical: 12, alignItems: 'center', width: '100%', marginTop: 8 },
  btnOutlineText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
});
