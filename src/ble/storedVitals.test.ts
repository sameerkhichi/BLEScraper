import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStoredSpo2, parseStoredTemperature, STORED_SPO2, STORED_TEMPERATURE } from './storedVitals';

const now = new Date(Date.UTC(2026, 10, 8, 15, 0, 0));

function series(type: number, payload: number[]): Uint8Array {
  const bytes = [0xbc, type, payload.length & 0xff, (payload.length >> 8) & 0xff, 0x00, 0x00, ...payload];
  return Uint8Array.from(bytes);
}

test('an empty temperature reply has no spots', () => {
  assert.deepEqual(parseStoredTemperature(series(STORED_TEMPERATURE, [0, 0x1e]), now), []);
});

test('temperature slots are half hours and unsigned', () => {
  const samples = Array(48).fill(0);
  samples[39] = 141;
  samples[40] = 118;
  const spots = parseStoredTemperature(series(STORED_TEMPERATURE, [1, 0x1e, ...samples]), now);
  assert.deepEqual(spots, [
    { timestamp: '2026-11-07T19:30:00.000Z', spo2: null, bodyTemperatureC: 34.1 },
    { timestamp: '2026-11-07T20:00:00.000Z', spo2: null, bodyTemperatureC: 31.8 },
  ]);
});

test('stored blood oxygen keeps one percent per half hour', () => {
  const samples = Array(48).fill(0);
  samples[2] = 98;
  const spots = parseStoredSpo2(series(STORED_SPO2, [0, 0x1e, ...samples]), now);
  assert.deepEqual(spots, [{ timestamp: '2026-11-08T01:00:00.000Z', spo2: 98, bodyTemperatureC: null }]);
});

test('paired blood oxygen uses the higher plausible value', () => {
  const samples = Array(96).fill(0);
  samples[0] = 97;
  samples[1] = 99;
  const spots = parseStoredSpo2(series(STORED_SPO2, [0, 0x1e, ...samples]), now);
  assert.equal(spots[0]?.spo2, 99);
  assert.equal(spots[0]?.timestamp, '2026-11-08T00:00:00.000Z');
});

test('a sleep packet is not read as stored blood oxygen', () => {
  assert.throws(() => parseStoredSpo2(series(0x27, [0, 0x1e]), now), /Blood oxygen/);
});
