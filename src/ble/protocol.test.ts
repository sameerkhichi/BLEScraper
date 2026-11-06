import assert from 'node:assert/strict';
import test from 'node:test';

import { base64ToBytes, bytesToBase64 } from './base64';
import { checksum, isValidPacket, makePacket } from './packet';
import {
  CMD_BATTERY,
  CMD_READ_HEART_RATE,
  CMD_SET_TIME,
  HeartRateLogParser,
  SportDetailParser,
  UART_SERVICE_UUID,
  advertisesColmiService,
  isLikelyRing,
  parseBattery,
  parseRealtime,
  setTimePacket,
} from './protocol';

test('battery request checksum is the command byte', () => {
  const packet = makePacket(CMD_BATTERY);
  assert.equal(packet[15], 3);
  assert.equal(isValidPacket(packet), true);
});

test('battery response reads level and charging', () => {
  const packet = new Uint8Array(16);
  packet[0] = CMD_BATTERY;
  packet[1] = 64;
  packet[2] = 1;
  packet[15] = checksum(packet);

  assert.deepEqual(parseBattery(packet), { level: 64, charging: true });
});

test('set time encodes UTC as BCD', () => {
  const packet = setTimePacket(new Date(Date.UTC(2026, 10, 6, 19, 45, 8)));
  assert.equal(packet[0], CMD_SET_TIME);
  assert.deepEqual(Array.from(packet.slice(1, 8)), [0x26, 0x11, 0x06, 0x19, 0x45, 0x08, 1]);
  assert.equal(isValidPacket(packet), true);
});

test('heart-rate log reassembles samples from multiple packets', () => {
  const parser = new HeartRateLogParser();
  const header = new Uint8Array(16);
  header[0] = CMD_READ_HEART_RATE;
  header[1] = 0;
  header[2] = 3;
  header[3] = 5;
  assert.equal(parser.parse(header), null);

  const stamp = Math.floor(Date.UTC(2024, 0, 1) / 1000);
  const first = new Uint8Array(16);
  first[0] = CMD_READ_HEART_RATE;
  first[1] = 1;
  first[2] = stamp & 0xff;
  first[3] = (stamp >> 8) & 0xff;
  first[4] = (stamp >> 16) & 0xff;
  first[5] = (stamp >> 24) & 0xff;
  first[6] = 70;
  assert.equal(parser.parse(first), null);

  const second = new Uint8Array(16);
  second[0] = CMD_READ_HEART_RATE;
  second[1] = 2;
  second[2] = 80;
  const log = parser.parse(second);

  assert.equal(log?.kind, 'log');
  if (log?.kind !== 'log') return;
  assert.deepEqual(log.samples, [
    { timestamp: '2024-01-01T00:00:00.000Z', bpm: 70 },
    { timestamp: '2024-01-01T00:45:00.000Z', bpm: 80 },
  ]);
});

test('steps parser returns no data and a finished interval', () => {
  const empty = new SportDetailParser();
  const none = new Uint8Array(16);
  none[0] = 67;
  none[1] = 255;
  assert.deepEqual(empty.parse(none), { kind: 'none' });

  const parser = new SportDetailParser();
  const header = new Uint8Array(16);
  header[0] = 67;
  header[1] = 240;
  header[3] = 1;
  assert.equal(parser.parse(header), null);

  const record = new Uint8Array(16);
  record[0] = 67;
  record[1] = 0x26;
  record[2] = 0x11;
  record[3] = 0x06;
  record[4] = 16;
  record[5] = 0;
  record[6] = 1;
  record[7] = 10;
  record[9] = 100;
  record[11] = 50;

  assert.deepEqual(parser.parse(record), [
    {
      timestamp: '2026-11-06T04:00:00.000Z',
      steps: 100,
      calories: 100,
      distanceMeters: 50,
    },
  ]);
});

test('realtime packet distinguishes a reading from an error', () => {
  assert.deepEqual(parseRealtime(Uint8Array.of(105, 1, 0, 72)), {
    kind: 'reading',
    reading: 1,
    value: 72,
  });
  assert.deepEqual(parseRealtime(Uint8Array.of(105, 1, 2, 0)), {
    kind: 'error',
    reading: 1,
    code: 2,
  });
});

test('QRing names such as COLMI_CA02 count as the ring', () => {
  assert.equal(isLikelyRing('COLMI_CA02'), true);
  assert.equal(isLikelyRing('COLMI_R09'), true);
  assert.equal(isLikelyRing('CA02'), true);
  assert.equal(isLikelyRing('R09'), true);
  assert.equal(isLikelyRing('iPhone'), false);
  assert.equal(isLikelyRing('Galaxy Buds'), false);
  assert.equal(isLikelyRing('  '), false);
});

test('Colmi service matching ignores case and dashes', () => {
  assert.equal(advertisesColmiService([UART_SERVICE_UUID.toLowerCase()]), true);
  assert.equal(advertisesColmiService(['6e40fff0b5a3f393e0a9e50e24dcca9e']), true);
  assert.equal(advertisesColmiService(['0000180a-0000-1000-8000-00805f9b34fb']), false);
});

test('base64 round-trips a 16-byte packet', () => {
  const packet = makePacket(CMD_BATTERY, [4, 5, 6]);
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(packet))), Array.from(packet));
});
