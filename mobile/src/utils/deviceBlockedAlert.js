import Notifications from './notificationsModule';
import { Platform } from 'react-native';
import { ensureNotificationPermission } from './eventReminders';

// Notification shown once when the device is blacklisted, rejected or removed.
export async function alertDeviceBlocked(message, deviceStatus) {
  try {
    const granted = await ensureNotificationPermission();
    if (!granted) return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('account-alerts', {
        name: 'Account Alerts',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    await Notifications.scheduleNotificationAsync({
      identifier: 'device-blocked',
      content: {
        title: deviceStatus === 'rejected' ? 'Device rejected' : deviceStatus === 'removed' ? 'Device removed' : 'Device blacklisted',
        body: message,
        sound: true,
      },
      // Immediate; same form as utils/faceVerificationAlert.js.
      trigger: Platform.OS === 'android' ? { channelId: 'account-alerts' } : null,
    });
  } catch (e) {
    // The Login screen still shows the message, so nothing more to do.
  }
}
