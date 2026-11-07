import assert from 'node:assert/strict';
import test from 'node:test';

import { batteryAlertCopy, LOW_BATTERY_REMIND_MS, nextBatteryNotice, type BatteryNotice } from './batteryAlert';

const now = Date.parse('2026-11-07T12:00:00.000Z');

function notice(level: number, minutesAgo: number): BatteryNotice {
  return {
    level,
    notifiedAt: new Date(now - minutesAgo * 60 * 1000).toISOString(),
  };
}

test('a missing or unusable battery reading leaves the last notice alone', () => {
  const previous = notice(12, 10);
  assert.deepEqual(nextBatteryNotice(null, previous, now), { notify: false, next: previous });
  assert.deepEqual(nextBatteryNotice({ level: -1, charging: false }, previous, now), {
    notify: false,
    next: previous,
  });
  assert.deepEqual(nextBatteryNotice({ level: 14.5, charging: false }, previous, now), {
    notify: false,
    next: previous,
  });
});

test('15% and above does not notify and clears a low-battery notice', () => {
  const previous = notice(12, 10);
  assert.deepEqual(nextBatteryNotice({ level: 15, charging: false }, previous, now), {
    notify: false,
    next: null,
  });
  assert.deepEqual(nextBatteryNotice({ level: 80, charging: true }, null, now), {
    notify: false,
    next: null,
  });
});

test('the first reading below 15% notifies, including while charging', () => {
  const low = nextBatteryNotice({ level: 14, charging: false }, null, now);
  assert.equal(low.notify, true);
  assert.deepEqual(low.next, { level: 14, notifiedAt: new Date(now).toISOString() });
  assert.equal(batteryAlertCopy({ level: 14, charging: false }).body, 'The ring is at 14%. Charge it soon.');

  const charging = nextBatteryNotice({ level: 9, charging: true }, null, now);
  assert.equal(charging.notify, true);
  assert.equal(batteryAlertCopy({ level: 9, charging: true }).body, 'The ring is at 9% and charging.');
});

test('the same low level waits out the reminder, and a drop notifies immediately', () => {
  const previous = notice(14, 10);
  const same = nextBatteryNotice({ level: 14, charging: false }, previous, now);
  assert.deepEqual(same, { notify: false, next: previous });

  const dropped = nextBatteryNotice({ level: 10, charging: false }, previous, now);
  assert.equal(dropped.notify, true);
  assert.equal(dropped.next?.level, 10);

  const reminded = nextBatteryNotice(
    { level: 14, charging: false },
    notice(14, LOW_BATTERY_REMIND_MS / 60_000),
    now,
  );
  assert.equal(reminded.notify, true);
  assert.equal(reminded.next?.level, 14);
});

test('a rise that is still below 15% keeps the lower notice until the reminder', () => {
  const previous = notice(10, 10);
  assert.deepEqual(nextBatteryNotice({ level: 12, charging: false }, previous, now), {
    notify: false,
    next: previous,
  });
});
