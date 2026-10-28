import React, { useRef } from 'react';
import { Animated, Text, TouchableWithoutFeedback, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, radius, shadow } from '../theme';

// Button with press animation and loading spinner.
export default function PrimaryButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  variant = 'solid', // 'solid' | 'light' (white button used on colored surfaces, e.g. camera footer)
  style,
  textStyle,
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const isDisabled = disabled || loading;

  const pressIn = () => {
    if (isDisabled) return;
    Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  };
  const pressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 6 }).start();
  };

  return (
    <TouchableWithoutFeedback
      onPress={isDisabled ? undefined : onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
    >
      <Animated.View
        style={[
          styles.base,
          variant === 'light' ? styles.light : styles.solid,
          isDisabled && styles.disabled,
          { transform: [{ scale }] },
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={variant === 'light' ? colors.primary : '#fff'} />
        ) : (
          <Text style={[variant === 'light' ? styles.lightText : styles.solidText, textStyle]}>{title}</Text>
        )}
      </Animated.View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.md, paddingVertical: 15, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  solid: { backgroundColor: colors.primary, ...shadow, shadowColor: colors.primary, shadowOpacity: 0.25 },
  solidText: { color: '#fff', fontWeight: '700', fontSize: 15, letterSpacing: 0.1 },
  light: { backgroundColor: '#fff' },
  lightText: { color: colors.primary, fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.5 },
});
