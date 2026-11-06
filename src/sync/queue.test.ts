import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeReadings, type UploadPayload } from '../model';
import { enqueue, flushQueue } from './queue';

function sample(bpm: number): UploadPayload {
  return {
    source: 'colmi-r09',
    syncedAt: '2026-11-06T00:00:00.000Z',
    ring: { id: 'ring', name: 'R09' },
    battery: { level: 80, charging: false },
    realtimeHeartRate: bpm,
    spo2: null,
    bodyTemperatureC: null,
    accelerometer: null,
    heartRate: [],
    steps: [],
    warnings: [],
  };
}

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
  const next = sample(0);
  next.realtimeHeartRate = null;
  next.spo2 = 98;
  next.syncedAt = '2026-11-06T00:01:00.000Z';

  const merged = mergeReadings(previous, next, true);
  assert.equal(merged.realtimeHeartRate, 72);
  assert.equal(merged.spo2, 98);
  assert.equal(merged.syncedAt, '2026-11-06T00:01:00.000Z');
});
