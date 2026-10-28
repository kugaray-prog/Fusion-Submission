import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

// Shows a retry screen instead of a blank screen on a render error.
export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[AppErrorBoundary]', error, info && info.componentStack);
  }

  reset = () => this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));

  render() {
    if (!this.state.error) {
      return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
    }
    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <Ionicons name="alert-circle-outline" size={44} color={colors.cspcBlue} />
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>The screen couldn't be shown. Your account and registration are safe.</Text>
          <TouchableOpacity style={styles.button} onPress={this.reset} accessibilityRole="button">
            <Text style={styles.buttonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.cspcBlue, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 20, padding: 24, alignItems: 'center' },
  title: { fontSize: 18, fontWeight: '800', color: '#1B2559', marginTop: 12, marginBottom: 6 },
  body: { fontSize: 14, color: '#64748B', textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  button: { backgroundColor: colors.cspcBlue, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 28 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
