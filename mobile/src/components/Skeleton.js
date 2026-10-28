import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet } from 'react-native';
import { colors, radius } from '../theme';

// Shimmering placeholder block.
export function SkeletonBlock({ width = '100%', height = 14, radius: r = 8, style }) {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);

  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: r, backgroundColor: colors.border, opacity },
        style,
      ]}
    />
  );
}

// Placeholder shaped like an event/history row.
export function SkeletonListCard({ style }) {
  return (
    <View style={[styles.card, style]}>
      <View style={styles.row}>
        <SkeletonBlock width={38} height={38} radius={12} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <SkeletonBlock width="70%" height={13} />
          <SkeletonBlock width="45%" height={11} style={{ marginTop: 8 }} />
        </View>
      </View>
    </View>
  );
}

export default function Skeleton({ rows = 3, style }) {
  return (
    <View style={style}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonListCard key={i} style={i > 0 ? { marginTop: 10 } : undefined} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 16,
    borderWidth: 1, borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
});
