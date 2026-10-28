import Notifications from './notificationsModule';
import { Platform } from 'react-native';
import { ensureNotificationPermission } from './eventReminders';

// Notification when Location or Wi-Fi is turned off; dismissed when back on.
const CHANNEL_ID = 'connectivity-alerts';

const MESSAGES = {
  location: {
    title: 'Location is turned off',
    body: 'Turn Location back on. Your attendance can\'t be tracked, and any open session is timed out, while it\'s off.',
  },
  wifi: {
    title: 'Wi-Fi is turned off',
    body: 'Connect back to the office Wi-Fi to keep using GeoAttend.',
  },
};

const identifierFor = (kind) => `service-off-${kind}`;

export async function alertServiceOff(kind) {
  const message = MESSAGES[kind];
  if (!message || Platform.OS === 'web') return;
  try {
    const granted = await ensureNotificationPermission();
    if (!granted) return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Location & Wi-Fi Alerts',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    await Notifications.scheduleNotificationAsync({
      identifier: identifierFor(kind),
      content: { ...message, sound: true, data: { type: 'service_off', kind } },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch (e) {
    // Non-fatal — the in-app overlay still blocks the app until it's back on.
  }
}

export function clearServiceOffAlert(kind) {
  if (!Notifications || Platform.OS === 'web') return;
  Notifications.dismissNotificationAsync(identifierFor(kind)).catch(() => {});
}
