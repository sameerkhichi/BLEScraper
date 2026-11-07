import { Platform } from 'react-native';

import { holdAndroidRadio, releaseAndroidRadio } from '../ble/androidRadio';
import { debugLog } from '../ble/debugLog';
import { closeRing, openRing } from '../ble/ringClient';
import { mergeReadings, type UploadPayload } from '../model';
import { enqueue, flushQueue } from './queue';
import { autoSyncPaused, runWithQueue, runWithRing } from './ringGate';
import {
  evaluateSchedule,
  HISTORY_INTERVAL_MS,
  readingChanged,
  shouldSync,
  type AutoSyncState,
  type SyncPlan,
} from './schedule';
import {
  loadAutoSyncState,
  loadLastPayload,
  loadQueue,
  loadSettings,
  saveAutoSyncState,
  saveLastPayload,
  saveQueue,
} from './storage';
import { collectRing } from './syncRing';
import { postPayload } from './upload';

const PAUSED_WAIT_MS = 30 * 1000;

export type AutoSyncResult = {
  outcome: 'idle' | 'synced' | 'saved' | 'failed';
  waitMs: number;
  message: string;
};

type Snapshot = {
  queue: Awaited<ReturnType<typeof loadQueue>>;
  lastPayload: UploadPayload | null;
};

let statusSink: ((message: string) => void) | null = null;
let snapshotSink: ((snapshot: Snapshot) => void) | null = null;

export function setAutoSyncStatusSink(sink: ((message: string) => void) | null): void {
  statusSink = sink;
}

export function setSyncSnapshotSink(sink: ((snapshot: Snapshot) => void) | null): void {
  snapshotSink = sink;
}

export async function markSyncCompleted(parts: { logs?: boolean; vitals?: boolean; sleep?: boolean }): Promise<void> {
  const state = await loadAutoSyncState();
  const now = new Date().toISOString();
  await saveAutoSyncState({
    ...state,
    failedAt: null,
    logsAt: parts.logs ? now : state.logsAt,
    vitalsAt: parts.vitals ? now : state.vitalsAt,
    sleepAt: parts.sleep ? now : state.sleepAt,
  });
}

export async function runAutoSync(options: { allowAndroidService: boolean }): Promise<AutoSyncResult> {
  if (Platform.OS === 'web') return idle(HISTORY_INTERVAL_MS);
  if (autoSyncPaused()) return idle(PAUSED_WAIT_MS);

  const settings = await loadSettings();
  if (!settings.autoSync || !settings.ringId) return idle(HISTORY_INTERVAL_MS);

  const decision = evaluateSchedule(await loadAutoSyncState(), Date.now());
  if (!shouldSync(decision.plan)) return idle(decision.waitMs);

  return runWithRing(async () => {
    const current = await loadSettings();
    if (!current.autoSync || !current.ringId || autoSyncPaused()) {
      const again = evaluateSchedule(await loadAutoSyncState(), Date.now());
      return idle(again.waitMs || PAUSED_WAIT_MS);
    }
    const plan = evaluateSchedule(await loadAutoSyncState(), Date.now());
    if (!shouldSync(plan.plan)) return idle(plan.waitMs);

    const ringId = current.ringId;
    let radioHeld = false;
    try {
      if (options.allowAndroidService) {
        try {
          await holdAndroidRadio();
          radioHeld = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'could not keep Bluetooth awake';
          debugLog(message);
        }
      }

      report('Connecting to the ring');
      const client = await openRing(ringId);
      const collected = await collectRing(client, ringId, current.ringName, plan.plan, report);
      await closeRing();
      if (radioHeld) {
        radioHeld = false;
        await releaseAndroidRadio();
      }

      return await runWithQueue(async () => {
        const previous = await loadLastPayload();
        const merged = mergeReadings(previous, withSleep(previous, collected.payload, collected.sleepLoaded), false);
        merged.syncedAt = new Date().toISOString();
        const changed = readingChanged(previous, merged);
        const storedQueue = await loadQueue();
        const nextQueue = changed ? enqueue(storedQueue, merged) : storedQueue;
        await saveLastPayload(merged);
        await saveQueue(nextQueue);
        const marks = advanceMarks(await loadAutoSyncState(), plan.plan);
        await saveAutoSyncState(marks);
        snapshotSink?.({ queue: nextQueue, lastPayload: merged });
        const waitMs = evaluateSchedule(marks, Date.now()).waitMs;

        if (!changed && nextQueue.length === 0) {
          return { outcome: 'saved' as const, waitMs, message: 'Ring checked. Nothing new to send.' };
        }
        if (!current.apiUrl.trim()) {
          return {
            outcome: 'saved' as const,
            waitMs,
            message: changed ? 'Saved on the phone. Add an API URL in Settings to send it.' : 'Ring checked. Nothing new to send.',
          };
        }
        if (nextQueue.length === 0) {
          return { outcome: 'saved' as const, waitMs, message: 'Ring checked. Nothing new to send.' };
        }

        report('Sending to the API');
        const flushed = await flushQueue(nextQueue, (body) => postPayload(current, body));
        await saveQueue(flushed.remaining);
        snapshotSink?.({ queue: flushed.remaining, lastPayload: merged });
        if (flushed.error) {
          return {
            outcome: 'saved' as const,
            waitMs,
            message:
              flushed.sent > 0
                ? `Sent ${flushed.sent}. ${flushed.remaining.length} still waiting. ${flushed.error}`
                : `Waiting to send. ${flushed.error}`,
          };
        }
        return {
          outcome: 'synced' as const,
          waitMs,
          message: flushed.sent > 0 ? 'Synced and sent.' : 'Nothing waiting to send.',
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed.';
      debugLog(message);
      const failed: AutoSyncState = { ...(await loadAutoSyncState()), failedAt: new Date().toISOString() };
      await saveAutoSyncState(failed);
      return { outcome: 'failed', waitMs: evaluateSchedule(failed, Date.now()).waitMs, message };
    } finally {
      await closeRing();
      if (radioHeld) await releaseAndroidRadio();
    }
  });
}

function withSleep(previous: UploadPayload | null, next: UploadPayload, sleepLoaded: boolean): UploadPayload {
  if (sleepLoaded || !previous) return next;
  return { ...next, sleep: previous.sleep };
}

function advanceMarks(state: AutoSyncState, plan: SyncPlan): AutoSyncState {
  const now = new Date().toISOString();
  return {
    logsAt: plan.logs ? now : state.logsAt,
    vitalsAt: plan.vitals ? now : state.vitalsAt,
    sleepAt: plan.sleep ? now : state.sleepAt,
    failedAt: null,
  };
}

function report(message: string): void {
  debugLog(message);
  statusSink?.(message);
}

function idle(waitMs: number): AutoSyncResult {
  return { outcome: 'idle', waitMs, message: '' };
}
