import type { UploadPayload } from '../model';

// The ring measures on its own. The phone only downloads the stored record.
// Opening the app waits this long after the last saved download. A background wake does not.
export const DOWNLOAD_HOURS = 4;
export const RETRY_MINUTES = 15;

export const DOWNLOAD_INTERVAL_MS = DOWNLOAD_HOURS * 60 * 60 * 1000;
export const RETRY_INTERVAL_MS = RETRY_MINUTES * 60 * 1000;
export const UNWORN_INTERVAL_MS = DOWNLOAD_INTERVAL_MS;
export const UPLOAD_INTERVAL_MS = 60 * 60 * 1000;
export const CATCHUP_HOURS = DOWNLOAD_HOURS;
export const CATCHUP_INTERVAL_MINUTES = DOWNLOAD_HOURS * 60;
// iOS processing wakes are the long overnight slot. Opening the app still uses evaluateSchedule.
export const PROCESSING_INTERVAL_MINUTES = 12 * 60;
// A refresh wake reads the recent record. Keep this equal to the native historyDays value.
export const REFRESH_HISTORY_DAYS = 2;
// The ring keeps about a week. One wake can still recover a missed day.
export const STORED_DAYS = 7;

export type SyncPlan = {
  logs: boolean;
  vitals: boolean;
  sleep: boolean;
};

export type AutoSyncState = {
  logsAt: string | null;
  vitalsAt: string | null;
  sleepAt: string | null;
  failedAt: string | null;
  asleepAt: string | null;
  uploadAt: string | null;
};

export const emptyAutoSyncState: AutoSyncState = {
  logsAt: null,
  vitalsAt: null,
  sleepAt: null,
  failedAt: null,
  asleepAt: null,
  uploadAt: null,
};

const idlePlan: SyncPlan = { logs: false, vitals: false, sleep: false };

export function shouldSync(plan: SyncPlan): boolean {
  return plan.logs || plan.vitals || plan.sleep;
}

export function evaluateSchedule(state: AutoSyncState, now: number): { plan: SyncPlan; waitMs: number } {
  const waiting = [
    remainingBlock(state.failedAt, RETRY_INTERVAL_MS, now),
    remainingBlock(state.asleepAt, UNWORN_INTERVAL_MS, now),
  ].filter((wait): wait is number => wait !== null);
  if (waiting.length > 0) {
    return { plan: idlePlan, waitMs: clampWait(Math.max(...waiting)) };
  }

  const logsDue = due(state.logsAt, DOWNLOAD_INTERVAL_MS, now);
  const sleepDue = due(state.sleepAt, DOWNLOAD_INTERVAL_MS, now);
  const downloadDue = logsDue || sleepDue;
  const plan: SyncPlan = {
    logs: downloadDue,
    vitals: false,
    sleep: downloadDue,
  };
  if (!shouldSync(plan)) {
    return {
      plan,
      waitMs: clampWait(
        Math.min(remaining(state.logsAt, DOWNLOAD_INTERVAL_MS, now), remaining(state.sleepAt, DOWNLOAD_INTERVAL_MS, now)),
      ),
    };
  }
  return { plan, waitMs: 0 };
}

export function evaluateUpload(
  uploadAt: string | null,
  pendingCount: number,
  now: number,
): { due: boolean; waitMs: number | null } {
  if (pendingCount <= 0) return { due: false, waitMs: null };
  const waitMs = remaining(uploadAt, UPLOAD_INTERVAL_MS, now);
  if (waitMs <= 0) return { due: true, waitMs: 0 };
  return { due: false, waitMs };
}

export function readingChanged(previous: UploadPayload | null, next: UploadPayload): boolean {
  if (!previous) return true;
  return snapshot(previous) !== snapshot(next);
}

function snapshot(payload: UploadPayload): string {
  return JSON.stringify({
    battery: payload.battery,
    realtimeHeartRate: payload.realtimeHeartRate,
    spo2: payload.spo2,
    bodyTemperatureC: payload.bodyTemperatureC,
    vitalSpots: payload.vitalSpots ?? [],
    heartRate: payload.heartRate,
    steps: payload.steps,
    stress: payload.stress ?? [],
    hrv: payload.hrv ?? [],
    sleep: payload.sleep,
  });
}

function due(at: string | null, intervalMs: number, now: number): boolean {
  const then = parseTime(at);
  if (then === null) return true;
  return now - then >= intervalMs;
}

function remainingBlock(at: string | null, intervalMs: number, now: number): number | null {
  const then = parseTime(at);
  if (then === null || now - then >= intervalMs) return null;
  return then + intervalMs - now;
}

function remaining(at: string | null, intervalMs: number, now: number): number {
  const then = parseTime(at);
  if (then === null) return 0;
  return Math.max(0, then + intervalMs - now);
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampWait(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, DOWNLOAD_INTERVAL_MS);
}
