import assert from 'node:assert/strict';
import test from 'node:test';

import { keepSleepRecord, keepStoredSamples, mergeReadings, type UploadPayload } from '../model';
import { enqueue, flushQueue, forgetDropped, markDropped, removeFromQueue } from './queue';

function sample(bpm: number): UploadPayload {
  return {
    source: 'colmi-r09',
    syncedAt: '2026-11-06T00:00:00.000Z',
    ring: { id: 'ring', name: 'R09' },
    battery: { level: 80, charging: false },
    realtimeHeartRate: bpm,
    spo2: null,
    bodyTemperatureC: null,
    vitalSpots: [],
    accelerometer: null,
    heartRate: [],
    steps: [],
    sleep: [],
    warnings: [],
  };
}

test('remove drops one waiting reading and leaves the rest in order', () => {
  const queue = enqueue(
    enqueue([], sample(60), new Date('2026-11-06T00:00:00.000Z')),
    sample(70),
    new Date('2026-11-06T00:00:01.000Z'),
  );

  const removed = removeFromQueue(queue, queue[0].id);

  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, queue[1].id);
  assert.equal(removed[0].payload.realtimeHeartRate, 70);
  assert.equal(removeFromQueue(queue, 'missing').length, 2);
});

test('flush skips a reading removed while an earlier send is in flight', async () => {
  const queue = enqueue(
    enqueue([], sample(60), new Date('2026-11-06T00:00:00.000Z')),
    sample(70),
    new Date('2026-11-06T00:00:01.000Z'),
  );
  const sent: number[] = [];

  try {
    const result = await flushQueue(queue, async (payload) => {
      if (payload.realtimeHeartRate === 60) markDropped(queue[1].id);
      sent.push(payload.realtimeHeartRate ?? 0);
    });

    assert.deepEqual(sent, [60]);
    assert.equal(result.remaining.length, 0);
    assert.equal(result.error, null);
  } finally {
    forgetDropped(queue[1].id);
  }
});

test('a removed reading is left out when an earlier send fails', async () => {
  const queue = enqueue(
    enqueue([], sample(60), new Date('2026-11-06T00:00:00.000Z')),
    sample(70),
    new Date('2026-11-06T00:00:02.000Z'),
  );
  markDropped(queue[1].id);

  try {
    const result = await flushQueue(queue, async () => {
      throw new Error('Arduino unreachable');
    });

    assert.equal(result.sent, 0);
    assert.equal(result.remaining.length, 1);
    assert.equal(result.remaining[0].payload.realtimeHeartRate, 60);
    assert.equal(result.error, 'Arduino unreachable');
  } finally {
    forgetDropped(queue[1].id);
  }
});

test('flush sends queued payloads in order and stops on the first failure', async () => {
  const queue = enqueue(enqueue([], sample(60)), sample(70));
  const sent: number[] = [];

  const result = await flushQueue(queue, async (payload) => {
    if (payload.realtimeHeartRate === 70) throw new Error('Arduino unreachable');
    sent.push(payload.realtimeHeartRate ?? 0);
  });

  assert.deepEqual(sent, [60]);
  assert.equal(result.sent, 1);
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].payload.realtimeHeartRate, 70);
  assert.equal(result.error, 'Arduino unreachable');
});

test('a blood-oxygen reading keeps the last heart rate', () => {
  const previous = sample(72);
  previous.spo2 = 97;
  previous.realtimeHeartRateAt = '2026-11-06T00:00:00.000Z';
  const next = sample(0);
  next.realtimeHeartRate = null;
  next.spo2 = 98;
  next.syncedAt = '2026-11-06T00:01:00.000Z';

  const merged = mergeReadings(previous, next, true);
  assert.equal(merged.realtimeHeartRate, 72);
  assert.equal(merged.realtimeHeartRateAt, '2026-11-06T00:00:00.000Z');
  assert.equal(merged.spo2, 98);
  assert.equal(merged.syncedAt, '2026-11-06T00:01:00.000Z');
});

test('a new heart rate records when it was taken', () => {
  const previous = sample(72);
  previous.realtimeHeartRateAt = '2026-11-06T00:00:00.000Z';
  const next = sample(80);
  next.syncedAt = '2026-11-06T00:05:00.000Z';

  const merged = mergeReadings(previous, next, true);
  assert.equal(merged.realtimeHeartRate, 80);
  assert.equal(merged.realtimeHeartRateAt, '2026-11-06T00:05:00.000Z');
});

test('a later download keeps older stored samples and updates the same minute', () => {
  const previous = sample(70);
  previous.heartRate = [{ timestamp: '2026-11-05T12:00:00.000Z', bpm: 60 }];
  previous.steps = [{ timestamp: '2026-11-05T12:00:00.000Z', steps: 10, calories: 1, distanceMeters: 8 }];
  const next = sample(72);
  next.heartRate = [{ timestamp: '2026-11-06T12:00:00.000Z', bpm: 80 }];
  next.steps = [{ timestamp: '2026-11-05T12:00:00.000Z', steps: 25, calories: 2, distanceMeters: 18 }];

  const merged = keepStoredSamples(previous, next);
  assert.deepEqual(
    merged.heartRate.map((sample) => sample.bpm),
    [60, 80],
  );
  assert.equal(merged.steps.length, 1);
  assert.equal(merged.steps[0].steps, 25);
});

test('vital spots accumulate by timestamp and drop after 10 days', () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const previous = sample(70);
  previous.vitalSpots = [
    { timestamp: '2026-10-26T12:00:00.000Z', spo2: 97, bodyTemperatureC: 36.4 },
    { timestamp: '2026-11-05T12:00:00.000Z', spo2: 98, bodyTemperatureC: 36.5 },
  ];
  const next = sample(72);
  next.vitalSpots = [{ timestamp: '2026-11-06T12:00:00.000Z', spo2: 99, bodyTemperatureC: 36.6 }];

  const merged = keepStoredSamples(previous, next, now);
  assert.deepEqual(
    merged.vitalSpots.map((spot) => spot.spo2),
    [98, 99],
  );
});

test('a live reading keeps the last sleep night and a sync replaces it', () => {
  const previous = sample(72);
  previous.sleep = [
    {
      daysAgo: 0,
      startedAt: '2026-11-05T23:00:00.000Z',
      endedAt: '2026-11-06T07:00:00.000Z',
      minutesAsleep: 400,
      minutesInBed: 480,
      minutesLight: 200,
      minutesDeep: 100,
      minutesRem: 100,
      minutesAwake: 20,
      minutesUnknown: 0,
      awakenings: 1,
      stages: [],
      cycles: [],
    },
  ];
  const next = sample(0);
  next.realtimeHeartRate = null;

  assert.equal(mergeReadings(previous, next, true).sleep[0].minutesAsleep, 400);
  assert.equal(mergeReadings(previous, next, false).sleep.length, 0);
});

test('a sleep read keeps stored heart rate and steps', () => {
  const previous = sample(72);
  previous.heartRate = [{ timestamp: '2026-11-06T04:00:00.000Z', bpm: 54 }];
  previous.steps = [{ timestamp: '2026-11-06T00:00:00.000Z', steps: 10, calories: 1, distanceMeters: 8 }];
  const incoming = sample(0);
  incoming.syncedAt = '2026-11-06T12:00:00.000Z';
  incoming.sleep = [
    {
      daysAgo: 0,
      startedAt: '2026-11-05T23:00:00.000Z',
      endedAt: '2026-11-06T07:00:00.000Z',
      minutesAsleep: 420,
      minutesInBed: 480,
      minutesLight: 200,
      minutesDeep: 120,
      minutesRem: 100,
      minutesAwake: 20,
      minutesUnknown: 0,
      awakenings: 1,
      stages: [],
      cycles: [],
    },
  ];

  const saved = keepStoredSamples(previous, keepSleepRecord(previous, incoming));
  assert.equal(saved.sleep[0].minutesAsleep, 420);
  assert.equal(saved.heartRate.length, 1);
  assert.equal(saved.steps[0].steps, 10);
  assert.equal(saved.realtimeHeartRate, 72);
});
