import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow, type } from '../theme';
import BottomNav from '../components/BottomNav';
import { getDeviceInfo } from '../utils/device';
import { assetUrl } from '../config';
import FadeIn from '../components/FadeIn';
import AppHeader from '../components/AppHeader';
import { useResponsive, MAX_WIDTH } from '../utils/responsive';

function InfoRow({ icon, label, value, mono }) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoIcon}>
        <Ionicons name={icon} size={17} color={colors.primary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={[styles.infoValue, mono && styles.mono]} numberOfLines={mono ? 1 : 2}>{value}</Text>
      </View>
    </View>
  );
}

// Mirrors the #screen-profile card from the CSPC GeoAttend web prototype:
// avatar circle, name/employee id, and a monospace device-info block.
export default function ProfileScreen({ navigation }) {
  const { employee, logout } = useAuth();
  // Show the placeholder avatar if the photo fails to load.
  const [photoFailed, setPhotoFailed] = useState(false);
  const photoUrl = assetUrl(employee?.face_photo_url);
  // Same model/ID the registration form showed for this phone.
  const device = getDeviceInfo();

  useEffect(() => {
    setPhotoFailed(false);
  }, [photoUrl]);

  const handleLogout = () => logout();
  const { topPad, contentStyle } = useResponsive();

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={[contentStyle(MAX_WIDTH.form), { paddingTop: topPad, paddingBottom: 20 }]}>
        <AppHeader title="My Profile" />

        <FadeIn>
          <View style={styles.card}>
            <View style={styles.avatarWrap}>
              <View style={styles.avatar}>
                {photoUrl && !photoFailed ? (
                  <Image
                    source={{ uri: photoUrl }}
                    style={styles.avatarPhoto}
                    onError={() => setPhotoFailed(true)}
                  />
                ) : (
                  <Ionicons name="person" size={34} color="#fff" />
                )}
              </View>
              <Text style={styles.name}>{employee?.full_name || 'User'}</Text>
              <Text style={styles.empId}>{employee?.employee_code || 'N/A'}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.infoBlock}>
              <InfoRow icon="business-outline" label="Department" value={employee?.department || '--'} />
              <InfoRow icon="phone-portrait-outline" label="Device model" value={device.model} />
              <InfoRow icon="finger-print-outline" label="Device ID" value={device.uid} mono />
            </View>
          </View>

          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.85}>
            <Ionicons name="log-out-outline" size={19} color={colors.dangerText} />
            <Text style={styles.logoutText}>Log out from this device</Text>
          </TouchableOpacity>
        </FadeIn>
      </ScrollView>
      <BottomNav active="Profile" navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 20,
    borderWidth: 1, borderColor: colors.border, ...shadow, marginBottom: 16,
  },
  avatarWrap: { alignItems: 'center', marginBottom: 18 },
  avatar: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', marginBottom: 12, overflow: 'hidden',
    borderWidth: 3, borderColor: colors.primaryLight,
  },
  avatarPhoto: { width: '100%', height: '100%' },
  name: { ...type.heading, textAlign: 'center' },
  empId: { ...type.caption, marginTop: 2 },
  divider: { borderTopWidth: 1, borderTopColor: colors.border, marginBottom: 6 },
  infoBlock: {},
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  infoIcon: {
    width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  infoLabel: { fontSize: 11, fontWeight: '600', color: colors.textSub },
  infoValue: { fontSize: 14, fontWeight: '600', color: colors.textMain, marginTop: 1 },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  logoutBtn: {
    flexDirection: 'row', gap: 8, backgroundColor: colors.white, borderRadius: radius.md,
    paddingVertical: 15, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.dangerBg,
  },
  logoutText: { color: colors.dangerText, fontWeight: '700', fontSize: 15 },
});
