import assert from 'node:assert/strict';
import test from 'node:test';

import { bytesToBase64 } from './base64';
import { SCAN_RESORT_MS, SCAN_STALE_MS, createScanTracker, resolveAdvertisedName, type ScanSighting } from './scanList';

function sighting(overrides: Partial<ScanSighting> & Pick<ScanSighting, 'id'>): ScanSighting {
  return {
    name: null,
    localName: null,
    rssi: -60,
    serviceUUIDs: null,
    manufacturerData: null,
    rawScanRecord: null,
    isConnectable: true,
    ...overrides,
  };
}

test('COLMI_CA02 is listed as a ring without the UART service', () => {
  const tracker = createScanTracker();
  const result = tracker.observe(
    sighting({ id: 'ring', localName: 'COLMI_CA02', rssi: -72, serviceUUIDs: null }),
    0,
  );
  assert.match(result.announce ?? '', /COLMI_CA02/);

  const listed = tracker.snapshot(0);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, 'COLMI_CA02');
  assert.equal(listed[0]?.likely, true);
  assert.equal(listed[0]?.match, 'Name COLMI_CA02');
});

test('a later advertisement without a name keeps the Colmi name', () => {
  const tracker = createScanTracker();
  tracker.observe(sighting({ id: 'ring', localName: 'COLMI_CA02', rssi: -70 }), 0);
  tracker.observe(sighting({ id: 'ring', localName: null, name: null, rssi: -68 }), 400);

  const listed = tracker.snapshot(1_000);
  assert.equal(listed[0]?.name, 'COLMI_CA02');
  assert.equal(listed[0]?.likely, true);
  assert.equal(listed[0]?.hits, 2);
});

test('devices stay readable and then age out', () => {
  const tracker = createScanTracker();
  tracker.observe(sighting({ id: 'phone', name: 'Pixel', rssi: -70 }), 0);

  assert.equal(tracker.snapshot(10_000).length, 1);
  assert.equal(tracker.snapshot(SCAN_STALE_MS + 1).length, 0);
});

test('small signal changes do not reshuffle the list', () => {
  const tracker = createScanTracker();
  tracker.observe(sighting({ id: 'a', name: 'Alpha', rssi: -50 }), 0);
  tracker.observe(sighting({ id: 'b', name: 'Bravo', rssi: -60 }), 0);
  assert.deepEqual(
    tracker.snapshot(0).map((device) => device.id),
    ['a', 'b'],
  );

  tracker.observe(sighting({ id: 'b', name: 'Bravo', rssi: -30 }), 1_000);
  assert.deepEqual(
    tracker.snapshot(1_000).map((device) => device.id),
    ['a', 'b'],
  );

  assert.deepEqual(
    tracker.snapshot(SCAN_RESORT_MS).map((device) => device.id),
    ['b', 'a'],
  );
});

test('a much stronger new device moves to the top once', () => {
  const tracker = createScanTracker();
  tracker.observe(sighting({ id: 'phone', name: 'Pixel', rssi: -70 }), 0);
  tracker.snapshot(0);
  tracker.observe(sighting({ id: 'close', name: 'Band', rssi: -40 }), 1_000);
  assert.equal(tracker.snapshot(1_000)[0]?.id, 'close');

  tracker.observe(sighting({ id: 'watch', name: 'Watch', rssi: -66 }), 1_500);
  assert.deepEqual(
    tracker.snapshot(1_500).map((device) => device.id),
    ['close', 'phone', 'watch'],
  );
});

test('a newly seen ring jumps above devices already on screen', () => {
  const tracker = createScanTracker();
  tracker.observe(sighting({ id: 'phone', name: 'Pixel', rssi: -40 }), 0);
  tracker.snapshot(0);
  tracker.observe(sighting({ id: 'ring', localName: 'COLMI_CA02', rssi: -80 }), 1_000);

  assert.equal(tracker.snapshot(1_000)[0]?.id, 'ring');
});

test('weak unnamed devices stay off the list', () => {
  const tracker = createScanTracker();
  tracker.observe(sighting({ id: 'anon', rssi: -70 }), 0);
  assert.equal(tracker.snapshot(0).length, 0);

  tracker.observe(sighting({ id: 'anon', rssi: -50 }), 500);
  assert.equal(tracker.snapshot(500)[0]?.name, 'Unnamed device');
});

test('advertised names are recovered from the scan record and manufacturer data', () => {
  const record = Uint8Array.from([11, 0x09, ...Buffer.from('COLMI_CA02')]);
  assert.equal(
    resolveAdvertisedName({
      name: null,
      localName: null,
      manufacturerData: null,
      rawScanRecord: bytesToBase64(record),
    }),
    'COLMI_CA02',
  );

  const json = Buffer.from(JSON.stringify({ localName: 'COLMI_R09', name: null }));
  assert.equal(
    resolveAdvertisedName({
      name: 'Watch',
      localName: null,
      manufacturerData: null,
      rawScanRecord: bytesToBase64(json),
    }),
    'COLMI_R09',
  );

  const manufacturer = Uint8Array.from([0x59, 0x00, ...Buffer.from('COLMI_CA02')]);
  assert.equal(
    resolveAdvertisedName({
      name: null,
      localName: 'COLMI',
      manufacturerData: bytesToBase64(manufacturer),
      rawScanRecord: null,
    }),
    'COLMI_CA02',
  );
});
