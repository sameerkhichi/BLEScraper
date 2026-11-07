import type { UploadPayload } from '../model';

// The ring stores steps in 15-minute blocks and heart rate about every 5 minutes.
// Polling the logs faster than that keeps the radio awake without new samples.
// SpO2 and temperature turn the ring lights on for up to half a minute each,
// so those run half as often and share one connection with the log read.
export const HISTORY_MINUTES = 15;
export const VITALS_MINUTES = 30;
export const SLEEP_HOURS = 6;
export const RETRY_MINUTES = 15;
// An unworn ring goes back to sleep. The next check waits out a normal log interval.

export const HISTORY_INTERVAL_MS = HISTORY_MINUTES * 60 * 1000;
export const VITALS_INTERVAL_MS = VITALS_MINUTES * 60 * 1000;
export const SLEEP_INTERVAL_MS = SLEEP_HOURS * 60 * 60 * 1000;
export const RETRY_INTERVAL_MS = RETRY_MINUTES * 60 * 1000;
export const UNWORN_INTERVAL_MS = HISTORY_INTERVAL_MS;
export const UPLOAD_INTERVAL_MS = 60 * 60 * 1000;
// iOS will not keep a 15-minute timer alive after the app is suspended.
// A wake every 8 hours is the cadence it will actually schedule, about two or three times a day.
export const CATCHUP_HOURS = 8;
export const CATCHUP_INTERVAL_MINUTES = CATCHUP_HOURS * 60;
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

  const logsDue = due(state.logsAt, HISTORY_INTERVAL_MS, now);
  const vitalsDue = due(state.vitalsAt, VITALS_INTERVAL_MS, now);
  const sleepDue = due(state.sleepAt, SLEEP_INTERVAL_MS, now);
  const plan: SyncPlan = {
    logs: logsDue || vitalsDue || sleepDue,
    vitals: vitalsDue,
    sleep: sleepDue,
  };
  if (!shouldSync(plan)) {
    return {
      plan,
      waitMs: clampWait(
        Math.min(
          remaining(state.logsAt, HISTORY_INTERVAL_MS, now),
          remaining(state.vitalsAt, VITALS_INTERVAL_MS, now),
          remaining(state.sleepAt, SLEEP_INTERVAL_MS, now),
        ),
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
  return Math.min(ms, HISTORY_INTERVAL_MS);
}
