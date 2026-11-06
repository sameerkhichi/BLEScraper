import assert from 'node:assert/strict';
import test from 'node:test';

import type { UploadPayload } from '../model';
import { enqueue, flushQueue } from './queue';

function sample(bpm: number): UploadPayload {
  return {
    source: 'colmi-r09',
    syncedAt: '2026-11-06T00:00:00.000Z',
    ring: { id: 'ring', name: 'R09' },
    battery: { level: 80, charging: false },
    realtimeHeartRate: bpm,
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
