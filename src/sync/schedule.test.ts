import assert from 'node:assert/strict';
import test from 'node:test';

import type { UploadPayload } from '../model';
import {
  emptyAutoSyncState,
  evaluateSchedule,
  evaluateUpload,
  HISTORY_INTERVAL_MS,
  readingChanged,
  RETRY_INTERVAL_MS,
  SLEEP_INTERVAL_MS,
  UPLOAD_INTERVAL_MS,
  VITALS_INTERVAL_MS,
} from './schedule';

const t0 = Date.parse('2026-11-06T12:00:00.000Z');

function payload(patch: Partial<UploadPayload> = {}): UploadPayload {
  return {
    source: 'colmi-r09',
    syncedAt: '2026-11-06T12:00:00.000Z',
    ring: { id: 'ring', name: 'R09' },
    battery: { level: 80, charging: false },
    realtimeHeartRate: 60,
    spo2: 98,
    bodyTemperatureC: 36.5,
    vitalSpots: [],
    accelerometer: null,
    heartRate: [{ timestamp: '2026-11-06T12:00:00.000Z', bpm: 60 }],
    steps: [{ timestamp: '2026-11-06T12:00:00.000Z', steps: 10, calories: 1, distanceMeters: 8 }],
    sleep: [],
    warnings: [],
    ...patch,
  };
}

test('the first check reads logs, live vitals, and sleep', () => {
  const decision = evaluateSchedule(emptyAutoSyncState, t0);
  assert.deepEqual(decision.plan, { logs: true, vitals: true, sleep: true });
  assert.equal(decision.waitMs, 0);
});

test('a fresh check waits until the next log interval', () => {
  const decision = evaluateSchedule(
    { logsAt: new Date(t0).toISOString(), vitalsAt: new Date(t0).toISOString(), sleepAt: new Date(t0).toISOString(), failedAt: null },
    t0 + 10 * 60 * 1000,
  );
  assert.equal(decision.plan.logs, false);
  assert.equal(decision.plan.vitals, false);
  assert.equal(decision.waitMs, 5 * 60 * 1000);
});

test('logs are due at 15 minutes and live vitals stay off until 30', () => {
  const decision = evaluateSchedule(
    { logsAt: new Date(t0).toISOString(), vitalsAt: new Date(t0).toISOString(), sleepAt: new Date(t0).toISOString(), failedAt: null },
    t0 + HISTORY_INTERVAL_MS,
  );
  assert.deepEqual(decision.plan, { logs: true, vitals: false, sleep: false });
});

test('live vitals share the connection with a log refresh', () => {
  const decision = evaluateSchedule(
    { logsAt: new Date(t0).toISOString(), vitalsAt: new Date(t0).toISOString(), sleepAt: new Date(t0).toISOString(), failedAt: null },
    t0 + VITALS_INTERVAL_MS,
  );
  assert.equal(decision.plan.logs, true);
  assert.equal(decision.plan.vitals, true);
  assert.equal(decision.plan.sleep, false);
});

test('sleep does not turn the ring lights on', () => {
  const decision = evaluateSchedule(
    { logsAt: new Date(t0).toISOString(), vitalsAt: new Date(t0).toISOString(), sleepAt: null, failedAt: null },
    t0 + 60 * 1000,
  );
  assert.equal(decision.plan.logs, true);
  assert.equal(decision.plan.vitals, false);
  assert.equal(decision.plan.sleep, true);
});

test('an unworn ring stays asleep until the next log interval', () => {
  const cooling = evaluateSchedule(
    { ...emptyAutoSyncState, asleepAt: new Date(t0).toISOString() },
    t0 + 2 * 60 * 1000,
  );
  assert.equal(cooling.plan.logs, false);
  assert.equal(cooling.plan.vitals, false);
  assert.equal(cooling.plan.sleep, false);
  assert.equal(cooling.waitMs, HISTORY_INTERVAL_MS - 2 * 60 * 1000);

  const ready = evaluateSchedule(
    { ...emptyAutoSyncState, asleepAt: new Date(t0).toISOString() },
    t0 + HISTORY_INTERVAL_MS,
  );
  assert.equal(ready.plan.logs, true);
  assert.equal(ready.plan.sleep, true);
  assert.equal(ready.waitMs, 0);
});

test('an open app checks sleep when that is sooner than the next log read', () => {
  const decision = evaluateSchedule(
    {
      ...emptyAutoSyncState,
      logsAt: new Date(t0).toISOString(),
      vitalsAt: new Date(t0).toISOString(),
      sleepAt: new Date(t0 - SLEEP_INTERVAL_MS + 60 * 1000).toISOString(),
    },
    t0,
  );
  assert.equal(decision.plan.logs, false);
  assert.equal(decision.plan.sleep, false);
  assert.equal(decision.waitMs, 60 * 1000);
});

test('a failed check waits out the backoff before using the radio again', () => {
  const cooling = evaluateSchedule(
    { ...emptyAutoSyncState, failedAt: new Date(t0).toISOString() },
    t0 + 2 * 60 * 1000,
  );
  assert.equal(cooling.plan.logs, false);
  assert.equal(cooling.waitMs, RETRY_INTERVAL_MS - 2 * 60 * 1000);

  const ready = evaluateSchedule(
    { ...emptyAutoSyncState, failedAt: new Date(t0).toISOString() },
    t0 + RETRY_INTERVAL_MS,
  );
  assert.equal(ready.plan.logs, true);
  assert.equal(ready.waitMs, 0);
});

test('a clock jump does not schedule a multi-hour wait', () => {
  const decision = evaluateSchedule(
    {
      logsAt: new Date(t0 + 2 * 60 * 60 * 1000).toISOString(),
      vitalsAt: new Date(t0 + 2 * 60 * 60 * 1000).toISOString(),
      sleepAt: new Date(t0 + 2 * 60 * 60 * 1000).toISOString(),
      failedAt: null,
    },
    t0,
  );
  assert.equal(decision.plan.logs, false);
  assert.equal(decision.waitMs, HISTORY_INTERVAL_MS);
});

test('an empty queue does not schedule an upload', () => {
  assert.deepEqual(evaluateUpload(null, 0, t0), { due: false, waitMs: null });
  assert.deepEqual(evaluateUpload(new Date(t0).toISOString(), 0, t0 + 20 * 60 * 1000), { due: false, waitMs: null });
});

test('waiting readings with no previous attempt are due', () => {
  assert.deepEqual(evaluateUpload(null, 2, t0), { due: true, waitMs: 0 });
});

test('an upload attempt waits out the rest of the hour', () => {
  const decision = evaluateUpload(new Date(t0).toISOString(), 1, t0 + 20 * 60 * 1000);
  assert.equal(decision.due, false);
  assert.equal(decision.waitMs, UPLOAD_INTERVAL_MS - 20 * 60 * 1000);
});

test('an upload attempt is due again after an hour', () => {
  assert.deepEqual(evaluateUpload(new Date(t0).toISOString(), 1, t0 + UPLOAD_INTERVAL_MS), { due: true, waitMs: 0 });
});

test('an unchanged syncedAt does not count as a new reading', () => {
  const previous = payload();
  const next = payload({ syncedAt: '2026-11-06T12:15:00.000Z', warnings: ['ignored'] });
  assert.equal(readingChanged(previous, next), false);
  assert.equal(readingChanged(previous, payload({ steps: [{ timestamp: '2026-11-06T12:15:00.000Z', steps: 40, calories: 3, distanceMeters: 30 }] })), true);
  assert.equal(readingChanged(null, previous), true);
});

test('a new blood-oxygen spot counts as a new reading', () => {
  const previous = payload();
  const next = payload({
    spo2: 98,
    vitalSpots: [{ timestamp: '2026-11-06T20:00:00.000Z', spo2: 98, bodyTemperatureC: 36.6 }],
  });
  assert.equal(readingChanged(previous, next), true);
});
