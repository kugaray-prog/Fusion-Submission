import React, { useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, CSPC_LOGO } from '../theme';

// CSPC logo + title header; falls back to a globe icon if the logo fails to load.
export default function AppHeader({ title }) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <View style={styles.row}>
      <View style={styles.mark}>
        {!logoFailed ? (
          <Image
            source={CSPC_LOGO}
            style={styles.logoImage}
            resizeMode="contain"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <Ionicons name="school-outline" size={20} color={colors.primary} />
        )}
      </View>
      <View style={styles.textCol}>
        <Text style={styles.appName}>GeoAttend</Text>
        <Text style={styles.byLine}>By: Fusion</Text>
        {title ? <Text style={styles.screenTitle}>{title}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  mark: {
    width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.white,
    borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  logoImage: { width: 32, height: 32 },
  textCol: { flex: 1, minWidth: 0 },
  appName: { fontSize: 11, fontWeight: '700', color: colors.textSub, textTransform: 'uppercase', letterSpacing: 0.8 },
  byLine: { fontSize: 10, color: colors.textSub, marginTop: 1 },
  screenTitle: { fontSize: 20, fontWeight: '700', color: colors.textMain, marginTop: 1, letterSpacing: -0.3 },
});
