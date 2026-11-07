import { PermissionsAndroid, Platform } from 'react-native';

import { debugLog } from './debugLog';
import { getBleManager } from './manager';

let askedForNotifications = false;

export async function holdAndroidRadio(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!(await notificationsAllowed())) {
    debugLog('Notification permission is off. This check still runs while the app is open.');
    return;
  }
  await getBleManager().enableBackgroundMode({
    notificationTitle: 'BLEScraper',
    notificationText: 'Reading the ring. Bluetooth turns off when this finishes.',
  });
}

export async function releaseAndroidRadio(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await getBleManager().disableBackgroundMode();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'could not stop the Bluetooth notification';
    debugLog(message);
  }
}

async function notificationsAllowed(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return true;
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (await PermissionsAndroid.check(permission)) return true;
  if (askedForNotifications) return false;
  askedForNotifications = true;
  const result = await PermissionsAndroid.request(permission);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}
