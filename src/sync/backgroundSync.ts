import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { debugLog } from '../ble/debugLog';
import { closeRing } from '../ble/ringClient';
import { runAutoSync } from './autoSync';
import { HISTORY_MINUTES } from './schedule';

export const AUTO_SYNC_TASK = 'blescraper-auto-sync';

let expirationBound = false;

// Defined at import time so a background launch can find the task before React mounts.
if (Platform.OS !== 'web') {
  TaskManager.defineTask(AUTO_SYNC_TASK, async () => {
    try {
      await runAutoSync({ allowAndroidService: false });
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Background sync failed.';
      debugLog(message);
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
    if (!registered) {
      await BackgroundTask.registerTaskAsync(AUTO_SYNC_TASK, { minimumInterval: HISTORY_MINUTES });
      debugLog(`Background sync registered, about every ${HISTORY_MINUTES} minutes.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not register background sync.';
    debugLog(message);
  }
}
