import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { debugLog } from '../ble/debugLog';
import { closeRing } from '../ble/ringClient';
import { runCatchUp } from './autoSync';
import { notifyBackgroundResult, notifyBackgroundWake } from './notifyBattery';
import { CATCHUP_HOURS, CATCHUP_INTERVAL_MINUTES } from './schedule';
import { recordBackgroundWake } from './wakeLog';

export const AUTO_SYNC_TASK = 'blescraper-auto-sync';
const INTERVAL_KEY = 'blescraper.backgroundInterval';

let expirationBound = false;

// Defined at import time so a background launch can find the task before React mounts.
if (Platform.OS !== 'web') {
  TaskManager.defineTask(AUTO_SYNC_TASK, async () => {
    const startedAt = new Date();
    debugLog(`Background wake at ${startedAt.toISOString()}`);
    try {
      await recordBackgroundWake(startedAt, 'Background download started.');
      await notifyBackgroundWake(startedAt);
      const result = await runCatchUp();
      const note = result.message || 'Background download finished.';
      await recordBackgroundWake(startedAt, note);
      await notifyBackgroundResult(note);
      debugLog(note);
      return result.outcome === 'failed'
        ? BackgroundTask.BackgroundTaskResult.Failed
        : BackgroundTask.BackgroundTaskResult.Success;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Background sync failed.';
      debugLog(message);
      await recordBackgroundWake(startedAt, message).catch(() => undefined);
      await notifyBackgroundResult(message);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

function bindExpiration(): void {
  if (expirationBound || Platform.OS !== 'ios') return;
  expirationBound = true;
  BackgroundTask.addExpirationListener(() => {
    debugLog('Background time expired. Closing the ring.');
    void closeRing();
  });
}

bindExpiration();

export async function syncBackgroundRegistration(enabled: boolean): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(AUTO_SYNC_TASK);
    if (!enabled) {
      if (registered) await BackgroundTask.unregisterTaskAsync(AUTO_SYNC_TASK);
      return;
    }
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
      debugLog('Background sync is not available on this device.');
      return;
    }
    const wanted = `${CATCHUP_INTERVAL_MINUTES}:ble`;
    const saved = await AsyncStorage.getItem(INTERVAL_KEY);
    if (registered && saved === wanted) {
      debugLog(`Background download already scheduled, about every ${CATCHUP_HOURS} hours.`);
      return;
    }
    if (registered) await BackgroundTask.unregisterTaskAsync(AUTO_SYNC_TASK);
    await BackgroundTask.registerTaskAsync(AUTO_SYNC_TASK, { minimumInterval: CATCHUP_INTERVAL_MINUTES });
    await AsyncStorage.setItem(INTERVAL_KEY, wanted);
    debugLog(`Background download registered, about every ${CATCHUP_HOURS} hours.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not register background sync.';
    debugLog(message);
  }
}
