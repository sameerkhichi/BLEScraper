import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { debugLog } from '../ble/debugLog';
import type { BatteryReading } from '../model';
import { batteryAlertCopy, nextBatteryNotice, type BatteryNotice } from './batteryAlert';

const NOTICE_KEY = 'blescraper.batteryNotice';
const CHANNEL_ID = 'ring-battery';
const NOTIFICATION_ID = 'ring-battery-low';

type NotificationsModule = typeof import('expo-notifications');

let notificationsModule: Promise<NotificationsModule | null> | null = null;
let channelReady: Promise<void> | null = null;
let permissionRequested = false;
let loggedMissingPermission = false;
let delivery: Promise<void> = Promise.resolve();

export async function ensureNotificationPermission(request: boolean): Promise<boolean> {
  const notifications = await loadNotifications();
  if (!notifications) return false;
  await ensureChannel(notifications);
  const current = await notifications.getPermissionsAsync();
  if (current.status === 'granted') return true;
  if (!request || permissionRequested) return false;
  permissionRequested = true;
  const next = await notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: false, allowSound: true },
  });
  return next.status === 'granted';
}

export function reportBattery(battery: BatteryReading | null): Promise<void> {
  const run = delivery.then(() => deliverBatteryAlert(battery));
  delivery = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function deliverBatteryAlert(battery: BatteryReading | null): Promise<void> {
  try {
    const previous = await loadNotice();
    const decision = nextBatteryNotice(battery, previous, Date.now());
    if (!decision.notify || !battery) {
      if (!sameNotice(previous, decision.next)) await saveNotice(decision.next);
      return;
    }

    const notifications = await loadNotifications();
    if (!notifications) return;
    const allowed = await ensureNotificationPermission(false);
    if (!allowed) {
      if (!loggedMissingPermission) {
        loggedMissingPermission = true;
        debugLog('Ring battery is low. Notification permission is off.');
      }
      return;
    }

    const copy = batteryAlertCopy(battery);
    await notifications.dismissNotificationAsync(NOTIFICATION_ID).catch(() => undefined);
    await notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: {
        title: copy.title,
        body: copy.body,
        sound: 'default',
        interruptionLevel: 'active',
        data: { kind: 'battery', level: battery.level },
      },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
    await saveNotice(decision.next);
    debugLog(copy.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not send the battery notification.';
    debugLog(message);
  }
}

function loadNotifications(): Promise<NotificationsModule | null> {
  if (Platform.OS === 'web') return Promise.resolve(null);
  notificationsModule ??= import('expo-notifications')
    .then((notifications) => {
      notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldPlaySound: true,
          shouldSetBadge: false,
          shouldShowBanner: true,
          shouldShowList: true,
        }),
      });
      return notifications;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Notifications are unavailable until the app is rebuilt.';
      debugLog(message);
      return null;
    });
  return notificationsModule;
}

function ensureChannel(notifications: NotificationsModule): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  if (!channelReady) {
    channelReady = notifications
      .setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Ring battery',
        importance: notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        channelReady = null;
        throw error;
      });
  }
  return channelReady;
}

async function loadNotice(): Promise<BatteryNotice | null> {
  const raw = await AsyncStorage.getItem(NOTICE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<BatteryNotice>;
  if (typeof parsed.level !== 'number' || !Number.isInteger(parsed.level) || typeof parsed.notifiedAt !== 'string') {
    return null;
  }
  return { level: parsed.level, notifiedAt: parsed.notifiedAt };
}

async function saveNotice(notice: BatteryNotice | null): Promise<void> {
  if (!notice) {
    await AsyncStorage.removeItem(NOTICE_KEY);
    return;
  }
  await AsyncStorage.setItem(NOTICE_KEY, JSON.stringify(notice));
}

function sameNotice(left: BatteryNotice | null, right: BatteryNotice | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.level === right.level && left.notifiedAt === right.notifiedAt;
}
