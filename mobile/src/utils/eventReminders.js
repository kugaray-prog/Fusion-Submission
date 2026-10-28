import Notifications from './notificationsModule';
import { Platform } from 'react-native';

// How long before an event's start time to fire the local reminder.
const REMINDER_LEAD_MINUTES = 15;

// Show notifications while the app is in the foreground too.
Notifications?.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let permissionRequested = false;

// Asks once per app session; always false where notifications are unavailable.
export async function ensureNotificationPermission() {
  if (!Notifications) return false;
  if (permissionRequested) return true;
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  permissionRequested = true;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('event-reminders', {
      name: 'Event Reminders',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  return finalStatus === 'granted';
}

const identifierFor = (geofenceId) => `event-reminder-${geofenceId}`;

// "Starting soon" reminders for today's events and a one-time "happening now" alert.
const notifiedActive = new Set();

export async function scheduleTodayEventReminders(todaySchedule) {
  const granted = await ensureNotificationPermission();
  if (!granted || !Array.isArray(todaySchedule)) return;

  const now = Date.now();

  for (const g of todaySchedule) {
    if (g.computed_status === 'expired') continue;
    const startMs = new Date(g.start_datetime).getTime();
    if (Number.isNaN(startMs)) continue;

    const identifier = identifierFor(g.id);

    if (g.computed_status === 'active') {
      if (!notifiedActive.has(g.id)) {
        notifiedActive.add(g.id);
        await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
        await Notifications.scheduleNotificationAsync({
          identifier,
          content: {
            title: 'Event happening now',
            body: `"${g.title}" is ongoing at ${g.venue || 'the scheduled venue'}. Walk into the area to be timed in automatically.`,
            sound: true,
          },
          trigger: null, // fire immediately
        });
      }
      continue;
    }

    // Upcoming today: schedule a reminder REMINDER_LEAD_MINUTES before start.
    const triggerMs = startMs - REMINDER_LEAD_MINUTES * 60 * 1000;
    if (triggerMs <= now) continue; // lead window already passed; nothing useful to schedule

    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: 'Upcoming event today',
        body: `"${g.title}" starts at ${new Date(g.start_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${g.venue || 'venue TBA'}.`,
        sound: true,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(triggerMs) },
    });
  }
}

export default scheduleTodayEventReminders;
