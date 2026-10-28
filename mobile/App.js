import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from './src/context/AuthContext';
import { AttendanceTrackingProvider } from './src/context/AttendanceTrackingContext';
import { LocationStatusProvider } from './src/context/LocationStatusContext';
import { WifiStatusProvider } from './src/context/WifiStatusContext';
import { navigationRef } from './src/navigation/navigationRef';
import LocationGateOverlay from './src/components/LocationGateOverlay';
import WifiGateOverlay from './src/components/WifiGateOverlay';
import AppErrorBoundary from './src/components/AppErrorBoundary';
import LoginScreen from './src/screens/LoginScreen';
import RegistrationScreen from './src/screens/RegistrationScreen';
import WaitingApprovalScreen from './src/screens/WaitingApprovalScreen';
import WifiCheckScreen from './src/screens/WifiCheckScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import AttendanceScreen from './src/screens/AttendanceScreen';
import FaceVerificationScreen from './src/screens/FaceVerificationScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import { colors } from './src/theme';
// Registers the background attendance task at startup -- Android can relaunch
// the app's JS in the background just to deliver it a location reading.
import './src/tasks/backgroundAttendance';

const Stack = createNativeStackNavigator();

function RootNavigator() {
  const { employee, loading, deviceStatus, wifiVerified } = useAuth();

  // Unapproved device: only WaitingApproval until deviceStatus changes.
  const awaitingApproval = !!employee && deviceStatus === 'pending';

  // Each auth stage gets its own navigator instance (via `key`) instead of
  // one navigator swapping its whole screen list in place.
  const stage = !employee ? 'auth' : awaitingApproval ? 'pending' : !wifiVerified ? 'wifi' : 'app';

  // Render a spinner between stages so the old navigator fully unmounts first
  // (avoids a blank screen on some Android phones).
  const [shownStage, setShownStage] = useState(stage);
  useEffect(() => {
    if (stage === shownStage) return undefined;
    const t = setTimeout(() => setShownStage(stage), 250);
    return () => clearTimeout(t);
  }, [stage, shownStage]);

  if (loading || stage !== shownStage) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cspcBlue }}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <Stack.Navigator
      key={stage}
      screenOptions={{
        headerStyle: { backgroundColor: colors.cspcBlue },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '800' },
        animation: 'slide_from_right',
        animationDuration: 220,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      {!employee ? (
        <>
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Registration" component={RegistrationScreen} options={{ headerShown: false, animation: 'slide_from_right' }} />
        </>
      ) : awaitingApproval ? (
        <Stack.Screen name="WaitingApproval" component={WaitingApprovalScreen} options={{ headerShown: false, animation: 'fade' }} />
      ) : !wifiVerified ? (
        <Stack.Screen name="WifiCheck" component={WifiCheckScreen} options={{ headerShown: false, title: 'Network Check', animation: 'fade' }} />
      ) : (
        <>
          {/* Home / Logs / Profile render their own in-content header + bottom nav, mirroring the web prototype */}
          <Stack.Screen name="Dashboard" component={DashboardScreen} options={{ headerShown: false, animation: 'fade' }} />
          <Stack.Screen name="History" component={HistoryScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Profile" component={ProfileScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Attendance" component={AttendanceScreen} options={{ title: 'Mark Attendance', animation: 'slide_from_bottom' }} />
          {/* Auto-navigated to by AttendanceTrackingContext the instant a
              geo-anomaly flags an attendance record -- never opened by a
              button. gestureEnabled: false so it can't be casually
              swiped away on iOS; the in-screen "Cancel" button is the
              deliberate way out, and it explicitly does not confirm the
              flagged attendance (see FaceVerificationScreen.js). */}
          <Stack.Screen
            name="FaceVerification"
            component={FaceVerificationScreen}
            options={{ headerShown: false, animation: 'fade', gestureEnabled: false }}
          />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        {/* Above AttendanceTrackingProvider so that provider's own location
            watch can react to GPS being off (see AttendanceTrackingContext's
            use of useLocationStatus). */}
        <LocationStatusProvider>
          {/* Wi-Fi status is independent of location, but both gate
              AttendanceTrackingProvider and the app-wide overlays below the
              same way, so it's nested alongside LocationStatusProvider. */}
          <WifiStatusProvider>
            <AttendanceTrackingProvider>
              <NavigationContainer ref={navigationRef}>
                <StatusBar style="auto" />
                <AppErrorBoundary>
                  <RootNavigator />
                </AppErrorBoundary>
                {/* App-wide gates: block every screen behind a "turn on your
                    Location/GPS" or "turn on your Wi-Fi" prompt for as long as
                    the employee is signed in and that check is failing,
                    regardless of which screen they're on. */}
                <LocationGateOverlay />
                <WifiGateOverlay />
              </NavigationContainer>
            </AttendanceTrackingProvider>
          </WifiStatusProvider>
        </LocationStatusProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
