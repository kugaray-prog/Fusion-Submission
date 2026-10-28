import React, { createContext, useState, useEffect, useContext, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api, { googleLogin, linkDevice, getDeviceStatus, setStaleSessionHandler, setDeviceBlockedHandler } from '../api/client';
import { getDeviceUid } from '../utils/device';
import { startLive, stopLive, useLiveUpdates } from '../api/realtime';
import { alertDeviceBlocked } from '../utils/deviceBlockedAlert';
import { registerForPushNotifications, unregisterPushNotifications } from '../utils/pushNotifications';

// Re-check for a blocked/removed device (also on foreground and on DEVICE_BLOCKED).
const DEVICE_CHECK_INTERVAL_MS = 10000;
const BLOCKED_STATUSES = ['blacklisted', 'rejected', 'removed'];
const DEFAULT_BLOCKED_MESSAGE = {
  blacklisted: 'This device has been blacklisted by your administrator, so it can no longer be used to sign in or record attendance. Contact your administrator if you think this is a mistake.',
  rejected: "This device's registration was rejected by your administrator, so it can't be used to sign in or record attendance. Contact your administrator.",
  removed: 'This device was removed by your administrator. Sign in again to register it.',
};

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [employee, setEmployee] = useState(null);
  const [loading, setLoading] = useState(true);
  // This device's mobile_devices.status: 'pending' | 'approved' | 'rejected' | null.
  const [deviceStatus, setDeviceStatus] = useState(null);
  // Set right after a Google sign-in that didn't match an existing employee yet —
  // consumed by RegistrationScreen to finish linking the device.
  const [pendingGoogle, setPendingGoogle] = useState(null); // { pendingToken, google, existingEmployee }
  // The employee record no longer exists on the server (explained on LoginScreen).
  const [staleSession, setStaleSession] = useState(false);
  // WifiCheck passed this app session (not persisted).
  const [wifiVerified, setWifiVerified] = useState(false);
  const markWifiVerified = () => setWifiVerified(true);
  // { text, status } shown on Login after a blocked-device sign-out.
  const [deviceBlockedNotice, setDeviceBlockedNotice] = useState(null);
  const blockedHandledRef = useRef(false);

  useEffect(() => {
    (async () => {
      const stored = await AsyncStorage.getItem('employee_data');
      const storedStatus = await AsyncStorage.getItem('device_status');
      if (stored) {
        setEmployee(JSON.parse(stored));
        setDeviceStatus(storedStatus || null);
      }
      setLoading(false);
      // Re-check with the server in case the device was approved (or revoked)
      // while the app was closed.
      if (stored) refreshDeviceStatus();
    })();
  }, []);

  // Live updates (api/realtime.js) run while an employee is signed in.
  useEffect(() => {
    if (employee) startLive();
    else stopLive();
  }, [employee]);

  // An admin approved, blocked or removed this phone: re-check right away
  // (approval leaves WaitingApproval, a block signs the app out).
  useLiveUpdates(['device'], () => {
    if (employee) refreshDeviceStatus();
  });

  const persistDeviceStatus = async (status) => {
    setDeviceStatus(status);
    if (status) await AsyncStorage.setItem('device_status', status);
    else await AsyncStorage.removeItem('device_status');
  };

  // Polled by WaitingApprovalScreen — asks the server for this device's current
  // status so the app can automatically move on once an admin approves it.
  const refreshDeviceStatus = async () => {
    try {
      const data = await getDeviceStatus(getDeviceUid());
      if (BLOCKED_STATUSES.includes(data.deviceStatus)) {
        handleDeviceBlocked(DEFAULT_BLOCKED_MESSAGE[data.deviceStatus], data.deviceStatus);
        return data.deviceStatus;
      }
      await persistDeviceStatus(data.deviceStatus);
      return data.deviceStatus;
    } catch (err) {
      // Network hiccup or expired token — leave the current status alone and
      // let the next poll try again.
      return deviceStatus;
    }
  };

  // Google ID token -> full login (device already registered) or a pendingToken
  // for registration (with existingEmployee to pre-fill the form).
  const loginWithGoogle = async (idToken) => {
    const data = await googleLogin(idToken, getDeviceUid());
    setStaleSession(false);
    setDeviceBlockedNotice(null);
    blockedHandledRef.current = false;
    if (data.matched) {
      await AsyncStorage.setItem('employee_token', data.token);
      await AsyncStorage.setItem('employee_data', JSON.stringify(data.employee));
      setEmployee(data.employee);
      await persistDeviceStatus(data.deviceStatus || null);
      return { matched: true };
    }
    setPendingGoogle({ pendingToken: data.pendingToken, google: data.google, existingEmployee: data.existingEmployee || null });
    return { matched: false, google: data.google };
  };

  // Registers the device and enrolls the face; formData comes from RegistrationScreen.
  const completeRegistration = async (formData) => {
    if (!pendingGoogle) throw new Error('Your Google sign-in session expired. Please sign in again.');
    formData.append('pendingToken', pendingGoogle.pendingToken);
    const data = await linkDevice(formData);
    blockedHandledRef.current = false;
    // Set all auth state in one batch so RootNavigator swaps stacks only once.
    await AsyncStorage.multiSet([
      ['employee_token', data.token],
      ['employee_data', JSON.stringify(data.employee)],
    ]);
    if (data.deviceStatus) await AsyncStorage.setItem('device_status', data.deviceStatus);
    else await AsyncStorage.removeItem('device_status');
    setDeviceBlockedNotice(null);
    setDeviceStatus(data.deviceStatus || null);
    setPendingGoogle(null);
    setEmployee(data.employee);
    return data;
  };

  const cancelRegistration = () => setPendingGoogle(null);

  const logout = async () => {
    // Needs the session token, so before it's removed; capped so an offline
    // phone isn't stuck on sign-out.
    await Promise.race([unregisterPushNotifications(), new Promise((r) => setTimeout(r, 3000))]);
    await AsyncStorage.multiRemove(['employee_token', 'employee_data', 'device_status']);
    setEmployee(null);
    setDeviceStatus(null);
    setWifiVerified(false);
  };

  // Device was blacklisted/rejected: sign out and keep the reason for Login.
  const handleDeviceBlocked = (message, status) => {
    const text = message || DEFAULT_BLOCKED_MESSAGE[status] || DEFAULT_BLOCKED_MESSAGE.blacklisted;
    setDeviceBlockedNotice({ text, status });
    if (blockedHandledRef.current) return;
    blockedHandledRef.current = true;
    logout();
    alertDeviceBlocked(text, status);
  };

  useEffect(() => {
    setDeviceBlockedHandler(handleDeviceBlocked);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // An approved phone registers for push notifications, so a new event
  // reaches it even while the app is closed.
  useEffect(() => {
    if (employee && deviceStatus === 'approved') registerForPushNotifications();
  }, [employee?.id, deviceStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // While signed in, re-check this device's status periodically and each
  // time the app returns to the foreground.
  useEffect(() => {
    if (!employee) return undefined;
    const interval = setInterval(refreshDeviceStatus, DEVICE_CHECK_INTERVAL_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshDeviceStatus();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [employee]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lets any API call sign out a stale session (see api/client.js).
  useEffect(() => {
    setStaleSessionHandler(() => {
      setStaleSession(true);
      logout();
    });
  }, []);

  return (
    <AuthContext.Provider value={{ employee, loading, deviceStatus, pendingGoogle, staleSession, deviceBlockedNotice, wifiVerified, markWifiVerified, loginWithGoogle, completeRegistration, cancelRegistration, refreshDeviceStatus, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
