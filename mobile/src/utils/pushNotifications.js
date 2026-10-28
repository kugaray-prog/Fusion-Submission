import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Notifications from './notificationsModule';
import { savePushToken } from '../api/client';

// Registers the Expo push token. Never throws.
export async function registerForPushNotifications() {
  if (!Notifications || Platform.OS === 'web' || !Device.isDevice) return null;
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return null;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    if (token) await savePushToken(token);
    return token || null;
  } catch (err) {
    console.log('[push] registration skipped:', err?.message || err);
    return null;
  }
}

// Clears this phone's push token on the server (on sign-out), so the next
// person to sign in here doesn't get the previous account's announcements.
export async function unregisterPushNotifications() {
  if (!Notifications || Platform.OS === 'web') return;
  try {
    await savePushToken(null);
  } catch (err) {
    console.log('[push] unregister skipped:', err?.message || err);
  }
}
