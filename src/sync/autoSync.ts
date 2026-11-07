import { Platform } from 'react-native';

import { holdAndroidRadio, releaseAndroidRadio } from '../ble/androidRadio';
import { debugLog } from '../ble/debugLog';
import { closeRing, openRing } from '../ble/ringClient';
import { keepSleepRecord, keepStoredSamples, mergeReadings, type AppSettings, type UploadPayload } from '../model';
import { enqueue, flushQueue } from './queue';
import { autoSyncPaused, runWithQueue, runWithRing } from './ringGate';
import {
  evaluateSchedule,
  evaluateUpload,
  HISTORY_INTERVAL_MS,
  readingChanged,
  RETRY_INTERVAL_MS,
  shouldSync,
  STORED_DAYS,
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
import { applyWornSpots, collectRing, measureWornSpots } from './syncRing';
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
    asleepAt: null,
    logsAt: parts.logs ? now : state.logsAt,
    vitalsAt: parts.vitals ? now : state.vitalsAt,
    sleepAt: parts.sleep ? now : state.sleepAt,
  });
}

export async function markRingAsleep(): Promise<number> {
  const state = await loadAutoSyncState();
  const next: AutoSyncState = { ...state, failedAt: null, asleepAt: new Date().toISOString() };
  await saveAutoSyncState(next);
  return evaluateSchedule(next, Date.now()).waitMs;
}

export async function markUploadAttempted(): Promise<void> {
  const state = await loadAutoSyncState();
  await saveAutoSyncState({ ...state, uploadAt: new Date().toISOString() });
}

export async function runCatchUp(): Promise<AutoSyncResult> {
  if (Platform.OS === 'web') return idle(HISTORY_INTERVAL_MS);
  if (autoSyncPaused()) return idle(PAUSED_WAIT_MS);

  const settings = await loadSettings();
  if (!settings.autoSync || !settings.ringId) return idle(HISTORY_INTERVAL_MS);

  return runWithRing(async () => {
    const current = await loadSettings();
    if (!current.autoSync || !current.ringId || autoSyncPaused()) return idle(PAUSED_WAIT_MS);

    let radioHeld = false;
    try {
      try {
        await holdAndroidRadio();
        radioHeld = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'could not keep Bluetooth awake';
        debugLog(message);
      }

      report('Waking to download the ring record');
      const client = await openRing(current.ringId);
      const collected = await collectRing(
        client,
        current.ringId,
        current.ringName,
        { logs: true, vitals: false, sleep: true },
        report,
        { probeWear: false, historyDays: STORED_DAYS },
      );
      let downloaded = collected.payload;
      try {
        downloaded = applyWornSpots(collected.payload, await measureWornSpots(client, report));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Blood oxygen and temperature were not read.';
        debugLog(message);
      }
      await closeRing();
      if (radioHeld) {
        radioHeld = false;
        await releaseAndroidRadio();
      }

      return await runWithQueue(async () => {
        const previous = await loadLastPayload();
        const merged = keepStoredSamples(
          previous,
          mergeReadings(previous, withSleep(previous, downloaded, collected.sleepLoaded), false),
        );
        merged.syncedAt = new Date().toISOString();
        const changed = readingChanged(previous, merged);
        const storedQueue = await loadQueue();
        const nextQueue = changed ? enqueue(storedQueue, merged) : storedQueue;
        await saveLastPayload(merged);
        await saveQueue(nextQueue);
        await markSyncCompleted({ logs: true, sleep: collected.sleepLoaded });
        snapshotSink?.({ queue: nextQueue, lastPayload: merged });
        const flushed = await flushQueueNow(current);
        if (flushed) return flushed;
        if (!current.apiUrl.trim()) {
          return { outcome: 'saved' as const, waitMs: HISTORY_INTERVAL_MS, message: 'Saved on the phone. Add an API URL in Settings to send it.' };
        }
        return { outcome: 'saved' as const, waitMs: HISTORY_INTERVAL_MS, message: 'Downloaded the ring record.' };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed.';
      debugLog(message);
      const failed: AutoSyncState = { ...(await loadAutoSyncState()), failedAt: new Date().toISOString() };
      await saveAutoSyncState(failed);
      return { outcome: 'failed', waitMs: HISTORY_INTERVAL_MS, message };
    } finally {
      await closeRing();
      if (radioHeld) await releaseAndroidRadio();
    }
  });
}

export async function runAutoSync(options: { allowAndroidService: boolean }): Promise<AutoSyncResult> {
  if (Platform.OS === 'web') return idle(HISTORY_INTERVAL_MS);
  if (autoSyncPaused()) return idle(PAUSED_WAIT_MS);

  const settings = await loadSettings();
  if (!settings.autoSync || !settings.ringId) return idle(HISTORY_INTERVAL_MS);

  const state = await loadAutoSyncState();
  const now = Date.now();
  const decision = evaluateSchedule(state, now);
  const storedQueue = await loadQueue();
  const upload = uploadDecision(settings, state.uploadAt, storedQueue.length, now);
  if (!shouldSync(decision.plan)) {
    if (!upload.due) return idle(combineWait(decision.waitMs, upload.waitMs));
    return runWithQueue(async () => (await flushIfDue(settings)) ?? idle(decision.waitMs));
  }

  return runWithRing(async () => {
    const current = await loadSettings();
    if (!current.autoSync || !current.ringId || autoSyncPaused()) {
      const again = evaluateSchedule(await loadAutoSyncState(), Date.now());
      return idle(again.waitMs || PAUSED_WAIT_MS);
    }
    const plan = evaluateSchedule(await loadAutoSyncState(), Date.now());
    if (!shouldSync(plan.plan)) {
      return runWithQueue(async () => {
        const flushed = await flushIfDue(current);
        if (flushed) return flushed;
        const pending = await loadQueue();
        const latest = await loadAutoSyncState();
        const again = uploadDecision(current, latest.uploadAt, pending.length, Date.now());
        return idle(combineWait(plan.waitMs, again.waitMs));
      });
    }

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
      if (!collected.worn) {
        await closeRing();
        if (radioHeld) {
          radioHeld = false;
          await releaseAndroidRadio();
        }
        if (collected.sleepLoaded) {
          return await runWithQueue(() => persistUnwornSleep(current, collected.payload));
        }
        const ringWait = await markRingAsleep();
        const flushed = await runWithQueue(() => flushIfDue(current));
        if (flushed) return { ...flushed, waitMs: Math.max(flushed.waitMs, ringWait) };
        const pending = await loadQueue();
        const latest = await loadAutoSyncState();
        const again = uploadDecision(current, latest.uploadAt, pending.length, Date.now());
        return {
          outcome: 'idle',
          waitMs: combineWait(ringWait, again.waitMs),
          message: collected.payload.warnings[0] ?? 'Ring is not being worn. Leaving it asleep.',
        };
      }
      await closeRing();
      if (radioHeld) {
        radioHeld = false;
        await releaseAndroidRadio();
      }

      return await runWithQueue(async () => {
        const previous = await loadLastPayload();
        const merged = keepStoredSamples(
          previous,
          mergeReadings(previous, withSleep(previous, collected.payload, collected.sleepLoaded), false),
        );
        merged.syncedAt = new Date().toISOString();
        const changed = readingChanged(previous, merged);
        const storedQueue = await loadQueue();
        const nextQueue = changed ? enqueue(storedQueue, merged) : storedQueue;
        await saveLastPayload(merged);
        await saveQueue(nextQueue);
        const sleepNeedsRetry = plan.plan.sleep && !collected.sleepLoaded;
        const marks = advanceMarks(await loadAutoSyncState(), plan.plan, collected.sleepLoaded);
        await saveAutoSyncState(marks);
        snapshotSink?.({ queue: nextQueue, lastPayload: merged });

        const flushed = await flushIfDue(current);
        if (flushed) return { ...flushed, waitMs: withSleepRetry(flushed.waitMs, sleepNeedsRetry) };

        const latest = await loadAutoSyncState();
        const checkedAt = Date.now();
        const again = uploadDecision(current, latest.uploadAt, nextQueue.length, checkedAt);
        const waitMs = withSleepRetry(
          combineWait(evaluateSchedule(latest, checkedAt).waitMs, again.waitMs),
          sleepNeedsRetry,
        );
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
        const readings = `${nextQueue.length} reading${nextQueue.length === 1 ? '' : 's'}`;
        return {
          outcome: 'saved' as const,
          waitMs,
          message: changed
            ? `Saved on the phone. ${readings} waiting until the next hourly send.`
            : `Ring checked. ${readings} waiting until the next hourly send.`,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed.';
      debugLog(message);
      const failed: AutoSyncState = { ...(await loadAutoSyncState()), failedAt: new Date().toISOString() };
      await saveAutoSyncState(failed);
      const pending = await loadQueue();
      const again = uploadDecision(current, failed.uploadAt, pending.length, Date.now());
      return {
        outcome: 'failed',
        waitMs: combineWait(evaluateSchedule(failed, Date.now()).waitMs, again.waitMs),
        message,
      };
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

async function persistUnwornSleep(settings: AppSettings, incoming: UploadPayload): Promise<AutoSyncResult> {
  const previous = await loadLastPayload();
  const merged = keepStoredSamples(previous, keepSleepRecord(previous, incoming));
  merged.syncedAt = new Date().toISOString();
  const changed = readingChanged(previous, merged);
  const storedQueue = await loadQueue();
  const nextQueue = changed ? enqueue(storedQueue, merged) : storedQueue;
  await saveLastPayload(merged);
  await saveQueue(nextQueue);
  await markSyncCompleted({ sleep: true });
  snapshotSink?.({ queue: nextQueue, lastPayload: merged });
  const ringWait = await markRingAsleep();

  const flushed = await flushIfDue(settings);
  if (flushed) return { ...flushed, waitMs: Math.max(flushed.waitMs, ringWait) };

  const latest = await loadAutoSyncState();
  const checkedAt = Date.now();
  const again = uploadDecision(settings, latest.uploadAt, nextQueue.length, checkedAt);
  const waitMs = combineWait(Math.max(evaluateSchedule(latest, checkedAt).waitMs, ringWait), again.waitMs);
  const note = 'Ring is not being worn.';
  if (!settings.apiUrl.trim()) {
    return {
      outcome: 'saved',
      waitMs,
      message: changed ? `Saved sleep on the phone. ${note}` : `${note} Sleep is already saved.`,
    };
  }
  if (nextQueue.length === 0) {
    return { outcome: 'saved', waitMs, message: changed ? `Saved sleep. ${note}` : `${note} Sleep is already saved.` };
  }
  const readings = `${nextQueue.length} reading${nextQueue.length === 1 ? '' : 's'}`;
  return {
    outcome: 'saved',
    waitMs,
    message: changed ? `Saved sleep on the phone. ${readings} waiting until the next hourly send. ${note}` : `${note} ${readings} waiting until the next hourly send.`,
  };
}

function advanceMarks(state: AutoSyncState, plan: SyncPlan, sleepLoaded: boolean): AutoSyncState {
  const now = new Date().toISOString();
  return {
    logsAt: plan.logs ? now : state.logsAt,
    vitalsAt: plan.vitals ? now : state.vitalsAt,
    sleepAt: plan.sleep && sleepLoaded ? now : state.sleepAt,
    failedAt: null,
    asleepAt: null,
    uploadAt: state.uploadAt,
  };
}

function withSleepRetry(waitMs: number, sleepNeedsRetry: boolean): number {
  if (!sleepNeedsRetry) return waitMs;
  return Math.max(waitMs, RETRY_INTERVAL_MS);
}

function uploadDecision(
  settings: AppSettings,
  uploadAt: string | null,
  pendingCount: number,
  now: number,
): { due: boolean; waitMs: number | null } {
  if (!settings.apiUrl.trim()) return { due: false, waitMs: null };
  return evaluateUpload(uploadAt, pendingCount, now);
}

function combineWait(ringWaitMs: number, uploadWaitMs: number | null): number {
  if (uploadWaitMs === null) return ringWaitMs;
  return Math.min(ringWaitMs, uploadWaitMs);
}

async function flushQueueNow(settings: AppSettings): Promise<AutoSyncResult | null> {
  if (!settings.apiUrl.trim()) return null;
  const queue = await loadQueue();
  if (queue.length === 0) return null;

  report('Sending to the API');
  await markUploadAttempted();
  const flushed = await flushQueue(queue, (body) => postPayload(settings, body));
  await saveQueue(flushed.remaining);
  snapshotSink?.({ queue: flushed.remaining, lastPayload: await loadLastPayload() });
  if (flushed.error) {
    return {
      outcome: 'saved',
      waitMs: HISTORY_INTERVAL_MS,
      message:
        flushed.sent > 0
          ? `Sent ${flushed.sent}. ${flushed.remaining.length} still waiting. ${flushed.error}`
          : `Waiting to send. ${flushed.error}`,
    };
  }
  return {
    outcome: 'synced',
    waitMs: HISTORY_INTERVAL_MS,
    message: flushed.sent > 0 ? 'Synced and sent.' : 'Nothing waiting to send.',
  };
}

async function flushIfDue(settings: AppSettings): Promise<AutoSyncResult | null> {
  if (!settings.apiUrl.trim()) return null;
  const queue = await loadQueue();
  const state = await loadAutoSyncState();
  const decision = evaluateUpload(state.uploadAt, queue.length, Date.now());
  if (!decision.due) return null;

  report('Sending to the API');
  await markUploadAttempted();
  const flushed = await flushQueue(queue, (body) => postPayload(settings, body));
  await saveQueue(flushed.remaining);
  snapshotSink?.({ queue: flushed.remaining, lastPayload: await loadLastPayload() });

  const latest = await loadAutoSyncState();
  const now = Date.now();
  const again = evaluateUpload(latest.uploadAt, flushed.remaining.length, now);
  const waitMs = combineWait(evaluateSchedule(latest, now).waitMs, again.waitMs);
  if (flushed.error) {
    return {
      outcome: 'saved',
      waitMs,
      message:
        flushed.sent > 0
          ? `Sent ${flushed.sent}. ${flushed.remaining.length} still waiting. ${flushed.error}`
          : `Waiting to send. ${flushed.error}`,
    };
  }
  return {
    outcome: 'synced',
    waitMs,
    message: flushed.sent > 0 ? 'Synced and sent.' : 'Nothing waiting to send.',
  };
}

function report(message: string): void {
  debugLog(message);
  statusSink?.(message);
}

function idle(waitMs: number): AutoSyncResult {
  return { outcome: 'idle', waitMs, message: '' };
}
