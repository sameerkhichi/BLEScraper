import assert from 'node:assert/strict';
import test from 'node:test';

import { BigDataAssembler, parseSleepPacket, sleepRequestPacket } from './sleep';

const NOW = new Date('2026-11-06T15:00:00.000Z');

test('sleep request matches the big-data command rings answer', () => {
  assert.deepEqual(Array.from(sleepRequestPacket()), [0xbc, 0x27, 0x01, 0x00, 0xff, 0x00, 0xff]);
});

test('sleep packet becomes nights, stage totals, and REM cycles', () => {
  const stages: Array<[number, number]> = [
    [2, 90],
    [3, 80],
    [2, 40],
    [4, 50],
    [2, 70],
    [3, 40],
    [4, 60],
    [5, 15],
    [2, 35],
  ];
  const nights = parseSleepPacket(sleepFrame([{ daysAgo: 0, start: 1380, end: 420, stages }]), NOW);

  assert.equal(nights.length, 1);
  const night = nights[0];
  assert.equal(night.startedAt, '2026-11-05T23:00:00.000Z');
  assert.equal(night.endedAt, '2026-11-06T07:00:00.000Z');
  assert.equal(night.minutesInBed, 480);
  assert.equal(night.minutesAsleep, 465);
  assert.equal(night.minutesLight, 235);
  assert.equal(night.minutesDeep, 120);
  assert.equal(night.minutesRem, 110);
  assert.equal(night.minutesAwake, 15);
  assert.equal(night.awakenings, 1);
  assert.equal(night.stages[0].stage, 'light');
  assert.equal(night.stages[0].startedAt, '2026-11-05T23:00:00.000Z');
  assert.equal(night.stages[3].stage, 'rem');
  assert.deepEqual(
    night.cycles.map((cycle) => cycle.complete),
    [true, true, false],
  );
  assert.equal(night.cycles[0].minutes, 260);
  assert.equal(night.cycles[0].endedAt, '2026-11-06T03:20:00.000Z');
  assert.equal(night.cycles[1].startedAt, '2026-11-06T03:20:00.000Z');
  assert.equal(night.cycles[2].startedAt, '2026-11-06T06:10:00.000Z');
});

test('a nap after midnight stays on the wake-up day', () => {
  const nights = parseSleepPacket(
    sleepFrame([{ daysAgo: 1, start: 90, end: 150, stages: [[3, 60]] }]),
    NOW,
  );
  assert.equal(nights[0].daysAgo, 1);
  assert.equal(nights[0].startedAt, '2026-11-05T01:30:00.000Z');
  assert.equal(nights[0].endedAt, '2026-11-05T02:30:00.000Z');
  assert.equal(nights[0].cycles[0].complete, false);
});

test('empty, zero-length, and unknown stages are kept usable', () => {
  assert.deepEqual(parseSleepPacket(Uint8Array.of(0xbc, 0x27, 0x00, 0x00, 0x00, 0x00), NOW), []);

  const nights = parseSleepPacket(
    sleepFrame([
      {
        daysAgo: 0,
        start: 120,
        end: 180,
        stages: [
          [2, 0],
          [9, 30],
          [4, 30],
        ],
      },
    ]),
    NOW,
  );
  assert.deepEqual(
    nights[0].stages.map((stage) => stage.stage),
    ['unknown', 'rem'],
  );
  assert.equal(nights[0].minutesUnknown, 30);
  assert.equal(nights[0].stages[0].startedAt, '2026-11-06T02:00:00.000Z');
  assert.equal(nights[0].cycles.length, 1);
  assert.equal(nights[0].cycles[0].complete, true);
});

test('several nights come back newest first', () => {
  const nights = parseSleepPacket(
    sleepFrame([
      { daysAgo: 2, start: 60, end: 120, stages: [[2, 60]] },
      { daysAgo: 0, start: 30, end: 90, stages: [[3, 60]] },
    ]),
    NOW,
  );
  assert.deepEqual(
    nights.map((night) => night.daysAgo),
    [0, 2],
  );
});

test('big-data notifications reassemble across chunks', () => {
  const stages = Array.from({ length: 12 }, (): [number, number] => [2, 10]);
  const packet = sleepFrame([{ daysAgo: 0, start: 0, end: 120, stages }]);
  assert.ok(packet.length > 20);
  const assembler = new BigDataAssembler();
  assert.equal(assembler.push(packet.subarray(0, 20)), null);
  const done = assembler.push(packet.subarray(20));
  assert.ok(done);
  assert.equal(parseSleepPacket(done, NOW)[0].minutesLight, 120);
});

function sleepFrame(
  days: Array<{ daysAgo: number; start: number; end: number; stages: Array<[number, number]> }>,
): Uint8Array {
  const payload: number[] = [days.length];
  for (const day of days) {
    const body = [day.start & 0xff, (day.start >> 8) & 0xff, day.end & 0xff, (day.end >> 8) & 0xff];
    for (const [type, minutes] of day.stages) body.push(type, minutes);
    payload.push(day.daysAgo, body.length, ...body);
  }
  return Uint8Array.from([0xbc, 0x27, payload.length & 0xff, (payload.length >> 8) & 0xff, 0x00, 0x00, ...payload]);
}
