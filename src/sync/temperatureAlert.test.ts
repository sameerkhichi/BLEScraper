import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fahrenheit,
  nextTemperatureNotice,
  temperatureAlertCopy,
  temperatureStage,
  TEMP_ALERT_REMIND_MS,
  type TemperatureNotice,
} from './temperatureAlert';

const now = Date.parse('2026-11-07T12:00:00.000Z');

function notice(stage: TemperatureNotice['stage'], celsius: number, minutesAgo: number): TemperatureNotice {
  return {
    stage,
    celsius,
    notifiedAt: new Date(now - minutesAgo * 60 * 1000).toISOString(),
  };
}

test('finger thresholds land on the stated fahrenheit points', () => {
  assert.equal(fahrenheit(38), 100.4);
  assert.equal(fahrenheit(35), 95);
  assert.equal(fahrenheit(32), 89.6);
  assert.equal(fahrenheit(28), 82.4);
});

test('stages split fever from the hypothermia lines', () => {
  assert.equal(temperatureStage(38.2), 'fever');
  assert.equal(temperatureStage(38), 'fever');
  assert.equal(temperatureStage(37.9), 'normal');
  assert.equal(temperatureStage(35), 'normal');
  assert.equal(temperatureStage(34.9), 'mild');
  assert.equal(temperatureStage(32), 'mild');
  assert.equal(temperatureStage(31.9), 'moderate');
  assert.equal(temperatureStage(28), 'moderate');
  assert.equal(temperatureStage(27.9), 'severe');
});

test('a missing reading leaves the last notice alone', () => {
  const previous = notice('mild', 34, 10);
  assert.deepEqual(nextTemperatureNotice(null, previous, now), { notify: false, next: previous });
  assert.deepEqual(nextTemperatureNotice(Number.NaN, previous, now), { notify: false, next: previous });
});

test('a normal reading clears an alert', () => {
  const previous = notice('fever', 38.4, 10);
  assert.deepEqual(nextTemperatureNotice(36, previous, now), { notify: false, next: null });
  assert.deepEqual(nextTemperatureNotice(35, null, now), { notify: false, next: null });
});

test('the first critical reading notifies', () => {
  const fever = nextTemperatureNotice(38, null, now);
  assert.equal(fever.notify, true);
  assert.equal(fever.next?.stage, 'fever');
  assert.equal(temperatureAlertCopy(38).title, 'Body temperature is high');
  assert.equal(temperatureAlertCopy(38).body, '38.0°C (100.4°F). Fever range.');

  const mild = nextTemperatureNotice(34.1, null, now);
  assert.equal(mild.notify, true);
  assert.equal(mild.next?.stage, 'mild');
  assert.equal(temperatureAlertCopy(34.1).body, '34.1°C (93.4°F). Mild hypothermia.');

  const severe = nextTemperatureNotice(27.5, null, now);
  assert.equal(severe.next?.stage, 'severe');
  assert.equal(temperatureAlertCopy(27.5).title, 'Body temperature is dangerously low');
});

test('the same stage waits, and a worse line notifies immediately', () => {
  const previous = notice('mild', 34, 10);
  const same = nextTemperatureNotice(33.4, previous, now);
  assert.equal(same.notify, false);
  assert.equal(same.next?.stage, 'mild');
  assert.equal(same.next?.notifiedAt, previous.notifiedAt);

  const worse = nextTemperatureNotice(31.2, previous, now);
  assert.equal(worse.notify, true);
  assert.equal(worse.next?.stage, 'moderate');
  assert.equal(temperatureAlertCopy(31.2).body, '31.2°C (88.2°F). Moderate hypothermia.');

  const reminded = nextTemperatureNotice(34, notice('mild', 34, TEMP_ALERT_REMIND_MS / 60_000), now);
  assert.equal(reminded.notify, true);
  assert.equal(reminded.next?.celsius, 34);
});

test('an improving stage is remembered without a new alert', () => {
  const previous = notice('moderate', 30, 10);
  const improved = nextTemperatureNotice(33, previous, now);
  assert.equal(improved.notify, false);
  assert.equal(improved.next?.stage, 'mild');
  assert.equal(improved.next?.notifiedAt, previous.notifiedAt);
});

test('switching between fever and hypothermia notifies', () => {
  const dropped = nextTemperatureNotice(34, notice('fever', 38.4, 10), now);
  assert.equal(dropped.notify, true);
  assert.equal(dropped.next?.stage, 'mild');

  const rose = nextTemperatureNotice(38.2, notice('severe', 27, 10), now);
  assert.equal(rose.notify, true);
  assert.equal(rose.next?.stage, 'fever');
});
