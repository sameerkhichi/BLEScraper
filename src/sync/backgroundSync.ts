import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { debugLog } from '../ble/debugLog';
import { closeRing } from '../ble/ringClient';
import { runCatchUp } from './autoSync';
import { beginBackgroundAttempt, noteBackgroundExpired } from './backgroundBudget';
import { notifyBackgroundWake } from './notifyBattery';
import { autoSyncPaused } from './ringGate';
import { CATCHUP_INTERVAL_MINUTES, evaluateSchedule, PROCESSING_INTERVAL_MINUTES, REFRESH_HISTORY_DAYS, shouldSync, STORED_DAYS } from './schedule';
import { loadAutoSyncState, loadQueue, loadSettings } from './storage';
import { recordBackgroundWake } from './wakeLog';
import { wakeNoticeBody, type WakeWork } from './wakeNotice';

export const AUTO_SYNC_TASK = 'blescraper-auto-sync';
const INTERVAL_KEY = 'blescraper.backgroundInterval';

let expirationBound = false;

type WakeBody = { data?: { historyDays?: number } };

function historyDaysFrom(body: WakeBody | undefined): number {
  const days = Number(body?.data?.historyDays);
  if (days === REFRESH_HISTORY_DAYS) return REFRESH_HISTORY_DAYS;
  return STORED_DAYS;
}

// Defined at import time so a background launch can find the task before React mounts.
if (Platform.OS !== 'web') {
  TaskManager.defineTask(AUTO_SYNC_TASK, async (body: WakeBody) => {
    const startedAt = new Date();
    beginBackgroundAttempt();
    debugLog(`Background wake at ${startedAt.toISOString()}`);
    try {
      const historyDays = historyDaysFrom(body);
      const work = await wakeWork(historyDays);
      const notice = work ? wakeNoticeBody(work) : null;
      await recordBackgroundWake(startedAt, notice ?? 'Background wake had nothing to download or send.');
      if (notice) await notifyBackgroundWake(startedAt, notice);
      const result = await runCatchUp({ historyDays });
      const note = result.message || 'Background download finished.';
      await recordBackgroundWake(startedAt, note);
      debugLog(note);
      return result.outcome === 'failed'
        ? BackgroundTask.BackgroundTaskResult.Failed
        : BackgroundTask.BackgroundTaskResult.Success;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Background sync failed.';
      debugLog(message);
      await recordBackgroundWake(startedAt, message).catch(() => undefined);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

async function wakeWork(historyDays: number): Promise<WakeWork | null> {
  if (autoSyncPaused()) return null;
  const settings = await loadSettings();
  if (!settings.autoSync || !settings.ringId) return null;
  const queue = await loadQueue();
  const canSend = Boolean(settings.apiUrl.trim());
  const decision = evaluateSchedule(await loadAutoSyncState(), Date.now());
  return {
    downloadDays: shouldSync(decision.plan) ? historyDays : null,
    waiting: canSend ? queue.length : 0,
    sendsAfter: canSend,
  };
}

function bindExpiration(): void {
  if (expirationBound || Platform.OS !== 'ios') return;
  expirationBound = true;
  BackgroundTask.addExpirationListener(() => {
    noteBackgroundExpired();
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
    const minutes = Platform.OS === 'ios' ? PROCESSING_INTERVAL_MINUTES : CATCHUP_INTERVAL_MINUTES;
    const wanted = `${minutes}:ble`;
    const saved = await AsyncStorage.getItem(INTERVAL_KEY);
    if (registered && saved === wanted) {
      debugLog('Background download is already scheduled.');
      return;
    }
    if (registered) await BackgroundTask.unregisterTaskAsync(AUTO_SYNC_TASK);
    await BackgroundTask.registerTaskAsync(AUTO_SYNC_TASK, { minimumInterval: minutes });
    await AsyncStorage.setItem(INTERVAL_KEY, wanted);
    debugLog('Background download registered.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not register background sync.';
    debugLog(message);
  }
}
