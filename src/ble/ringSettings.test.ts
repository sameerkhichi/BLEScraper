import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidPacket, makePacket } from './packet';
import { CMD_AUTO_HEART_RATE, CMD_AUTO_SPO2 } from './protocol';
import { describeFirmware, emptyFirmware, parseSetting, writeSettingPacket } from './ringSettings';

test('heart-rate write uses a 15 minute interval and keeps the rest of the read', () => {
  const previous = parseSetting(makePacket(CMD_AUTO_HEART_RATE, [1, 1, 15, 4, 5, 6]), CMD_AUTO_HEART_RATE);
  const packet = writeSettingPacket(CMD_AUTO_HEART_RATE, previous, { enabled: true, minutes: 15 });
  assert.equal(packet[0], 0x16);
  assert.deepEqual(Array.from(packet.slice(1, 7)), [2, 1, 15, 4, 5, 6]);
  assert.equal(isValidPacket(packet), true);
  assert.equal(parseSetting(packet, CMD_AUTO_HEART_RATE)?.minutes, 15);
});

test('both off bytes read as disabled and the later write reuses that byte', () => {
  const zero = parseSetting(makePacket(CMD_AUTO_HEART_RATE, [1, 0x00, 30, 9]), CMD_AUTO_HEART_RATE);
  const two = parseSetting(makePacket(CMD_AUTO_HEART_RATE, [1, 0x02, 30, 9]), CMD_AUTO_HEART_RATE);
  assert.equal(zero?.enabled, false);
  assert.equal(zero?.offByte, 0x00);
  assert.equal(two?.enabled, false);
  assert.equal(two?.offByte, 0x02);
  assert.equal(parseSetting(makePacket(CMD_AUTO_HEART_RATE, [1, 0x01, 30]), CMD_AUTO_HEART_RATE)?.enabled, true);

  const written = writeSettingPacket(CMD_AUTO_HEART_RATE, zero, { enabled: false, minutes: 30 });
  assert.equal(written[2], 0x00);
  assert.equal(written[3], 30);
  assert.equal(written[4], 9);
  assert.equal(writeSettingPacket(CMD_AUTO_SPO2, two, { enabled: false })[2], 0x02);
});

test('a toggle write keeps the tail from the previous read', () => {
  const previous = parseSetting(makePacket(CMD_AUTO_SPO2, [1, 0x02, 9, 8, 7, 6]), CMD_AUTO_SPO2);
  const packet = writeSettingPacket(CMD_AUTO_SPO2, previous, { enabled: true });
  assert.deepEqual(Array.from(packet.slice(0, 7)), [CMD_AUTO_SPO2, 2, 1, 9, 8, 7, 6]);
  assert.equal(isValidPacket(packet), true);
  assert.equal(parseSetting(makePacket(CMD_AUTO_SPO2, [1, 0x03]), CMD_AUTO_SPO2), null);
});

test('a firmware read names the echoed values', () => {
  const described = describeFirmware({
    ...emptyFirmware(),
    heartRate: parseSetting(makePacket(CMD_AUTO_HEART_RATE, [1, 1, 5]), CMD_AUTO_HEART_RATE),
    spo2: parseSetting(makePacket(CMD_AUTO_SPO2, [1, 1]), CMD_AUTO_SPO2),
    stress: parseSetting(makePacket(0x36, [1, 0]), 0x36),
    hrv: null,
    warnings: ['HRV was not written because the ring did not answer.'],
  });
  assert.match(described, /Heart rate every 5 minutes/);
  assert.match(described, /Blood oxygen on/);
  assert.match(described, /Stress off/);
  assert.match(described, /HRV is not available/);
  assert.match(described, /HRV was not written/);
});
