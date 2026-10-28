import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { colors } from '../theme';

// Same colors as the dashboard's .badge variants.
const VARIANTS = {
  default: { bg: colors.primaryLight, text: colors.primary },
  waiting: { bg: colors.warningBg, text: colors.warningText },
  soon: { bg: colors.infoBg, text: colors.infoText },
  success: { bg: colors.successBg, text: colors.successText },
  danger: { bg: colors.dangerBg, text: colors.dangerText },
};

export default function StatusPill({ label, variant = 'default' }) {
  const v = VARIANTS[variant] || VARIANTS.default;
  return (
    <Text style={[styles.pill, { backgroundColor: v.bg, color: v.text }]}>{label}</Text>
  );
}

const styles = StyleSheet.create({
  pill: {
    fontSize: 10,
    fontWeight: '700',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    overflow: 'hidden',
  },
});
