import React, { useEffect } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useWifiStatus } from '../context/WifiStatusContext';
import { useLocationStatus } from '../context/LocationStatusContext';
import { colors, radius, shadow } from '../theme';
import { MODAL_ORIENTATIONS } from '../utils/responsive';
import { alertServiceOff, clearServiceOffAlert } from '../utils/serviceOffAlert';

// Blocks the whole app while signed in and Wi-Fi is off.
// Hidden when Location is also off (LocationGateOverlay shows first).
export default function WifiGateOverlay() {
  const { employee, deviceStatus } = useAuth();
  const { wifiOn, checked, recheck } = useWifiStatus();
  const { locationEnabled } = useLocationStatus();
  // Not while awaiting approval (WaitingApproval needs neither).
  const visible = !!employee && deviceStatus !== 'pending' && checked && !wifiOn && locationEnabled;

  // Also post a phone notification while this is showing (see serviceOffAlert).
  useEffect(() => {
    if (visible) alertServiceOff('wifi');
    else clearServiceOffAlert('wifi');
  }, [visible]);

  if (!visible) return null;

  const openWifiSettings = async () => {
    try {
      if (Platform.OS === 'android') {
        await Linking.sendIntent('android.settings.WIFI_SETTINGS');
        return;
      }
    } catch (e) {
      // Falls through to the general Settings app below.
    }
    try {
      if (Platform.OS === 'ios') {
        // iOS can't deep-link to Wi-Fi settings.
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
            <Ionicons name="wifi-outline" size={38} color={colors.error} />
          </View>
          <Text style={styles.title}>Please turn on your Wi-Fi.</Text>
          <Text style={styles.subtitle}>
            GeoAttend needs your device's Wi-Fi turned on and connected to verify your location and attendance. Wi-Fi-dependent features are unavailable until it's turned back on.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={openWifiSettings}>
            <Text style={styles.btnText}>Turn On Wi-Fi</Text>
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
