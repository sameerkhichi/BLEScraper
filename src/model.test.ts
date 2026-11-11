import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activityForLocalDay,
  latestHeartRate,
  latestMetric,
  latestVital,
  stressHistoryDays,
  stressSummary,
  type MetricSample,
  type SleepNight,
  type StepSample,
  type VitalSpot,
} from './model';

function slot(timestamp: string, steps: number, calories: number, distanceMeters: number): StepSample {
  return { timestamp, steps, calories, distanceMeters };
}

function localIso(year: number, month: number, day: number, hour: number, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

test('activity for the local day keeps today and drops the days around it', () => {
  const now = new Date(2026, 10, 7, 16, 0, 0);
  const today = localIso(2026, 11, 7, 10);
  const earlyToday = localIso(2026, 11, 7, 0, 30);
  const lateToday = localIso(2026, 11, 7, 23, 30);
  const yesterdayEvening = localIso(2026, 11, 6, 22);
  const tomorrow = localIso(2026, 11, 8, 9);

  const total = activityForLocalDay(
    [
      slot(today, 100, 40, 80),
      slot(earlyToday, 7, 3, 5),
      slot(lateToday, 50, 15, 30),
      slot(yesterdayEvening, 500, 200, 400),
      slot(tomorrow, 900, 300, 700),
    ],
    now,
  );

  assert.equal(total.steps, 157);
  assert.equal(total.calories, 58);
  assert.equal(total.distanceMeters, 115);

  const offset = now.getTimezoneOffset();
  if (offset >= 60) {
    const late = new Date(lateToday);
    assert.notEqual(calendarDay(late, true), calendarDay(late, false));
  } else if (offset <= -60) {
    const early = new Date(earlyToday);
    assert.notEqual(calendarDay(early, true), calendarDay(early, false));
  }
});

function stress(timestamp: string, value: number): MetricSample {
  return { timestamp, value };
}

function night(startedAt: string, endedAt: string): SleepNight {
  return {
    daysAgo: 0,
    startedAt,
    endedAt,
    minutesAsleep: 0,
    minutesInBed: 0,
    minutesLight: 0,
    minutesDeep: 0,
    minutesRem: 0,
    minutesAwake: 0,
    minutesUnknown: 0,
    awakenings: 0,
    stages: [],
    cycles: [],
  };
}

test('stress summary uses the ring values from today and leaves the night out', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const sleep = [night(localIso(2026, 11, 7, 23), localIso(2026, 11, 8, 7))];
  const samples = [
    stress(localIso(2026, 11, 8, 1), 30),
    stress(localIso(2026, 11, 8, 2), 50),
    stress(localIso(2026, 11, 8, 7), 10),
    stress(localIso(2026, 11, 8, 10), 20),
    stress(localIso(2026, 11, 8, 11), 40),
    stress(localIso(2026, 11, 8, 16), 80),
    stress(localIso(2026, 11, 8, 17), 90),
    stress(localIso(2026, 11, 8, 12), 0),
    stress(localIso(2026, 11, 8, 13), 100),
  ];

  const summary = stressSummary(samples, sleep, now);

  assert.equal(summary.current?.value, 90);
  assert.equal(summary.current?.band, 'High');
  assert.deepEqual(
    summary.today.map((sample) => sample.value),
    [10, 20, 40, 80, 90],
  );
  assert.equal(summary.average, 48);
  assert.equal(summary.peak, 90);
  assert.equal(summary.highMinutes, 90);
  assert.deepEqual(summary.distribution, { Relaxed: 40, Low: 20, Moderate: 0, High: 40 });
  assert.equal(summary.trend, 'Rising');
  assert.equal(summary.overnight, 40);
  assert.equal(summary.week, null);
  assert.equal(summary.month, null);
});

test('stress summary caps a long high gap and counts a last high sample as 30 minutes', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const capped = stressSummary(
    [stress(localIso(2026, 11, 8, 10), 80), stress(localIso(2026, 11, 8, 12), 20)],
    [],
    now,
  );
  assert.equal(capped.highMinutes, 60);

  const last = stressSummary([stress(localIso(2026, 11, 8, 10), 80)], [], now);
  assert.equal(last.highMinutes, 30);
  assert.equal(last.trend, null);
});

test('stress summary compares the last three hours with earlier today', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const steady = stressSummary(
    [
      stress(localIso(2026, 11, 8, 10), 20),
      stress(localIso(2026, 11, 8, 11), 20),
      stress(localIso(2026, 11, 8, 16), 22),
      stress(localIso(2026, 11, 8, 17), 22),
    ],
    [],
    now,
  );
  assert.equal(steady.trend, 'Steady');

  const falling = stressSummary(
    [
      stress(localIso(2026, 11, 8, 10), 40),
      stress(localIso(2026, 11, 8, 11), 40),
      stress(localIso(2026, 11, 8, 16), 20),
      stress(localIso(2026, 11, 8, 17), 20),
    ],
    [],
    now,
  );
  assert.equal(falling.trend, 'Falling');
});

test('stress summary waits for enough earlier days before showing a baseline', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const earlier = [1, 2, 3, 4, 5, 6, 7, 8].map((daysAgo) => stress(localIso(2026, 11, 8 - daysAgo, 15), 40));
  const oneDay = stressSummary([stress(localIso(2026, 11, 7, 15), 40), stress(localIso(2026, 11, 8, 15), 10)], [], now);
  assert.equal(oneDay.week, null);

  const week = stressSummary(earlier.slice(0, 2), [], now);
  assert.deepEqual(week.week, { value: 40, days: 2 });
  assert.equal(week.month, null);

  const month = stressSummary(earlier, [], now);
  assert.deepEqual(month.week, { value: 40, days: 7 });
  assert.deepEqual(month.month, { value: 40, days: 8 });
});

test('stress history keeps daytime samples and reports average, peak, and minimum', () => {
  const sleep = [night(localIso(2026, 11, 7, 23), localIso(2026, 11, 8, 7))];
  const samples = [
    stress(localIso(2026, 11, 7, 15), 22),
    stress(localIso(2026, 11, 7, 23, 30), 70),
    stress(localIso(2026, 11, 8, 1), 30),
    stress(localIso(2026, 11, 8, 2), 50),
    stress(localIso(2026, 11, 8, 7), 10),
    stress(localIso(2026, 11, 8, 10), 20),
    stress(localIso(2026, 11, 8, 11), 40),
    stress(localIso(2026, 11, 8, 16), 80),
    stress(localIso(2026, 11, 8, 17), 90),
    stress(localIso(2026, 11, 8, 12), 0),
    stress(localIso(2026, 11, 8, 13), 100),
  ];

  const days = stressHistoryDays(samples, sleep);

  assert.deepEqual(
    days.map((day) => day.key),
    ['2026-11-07', '2026-11-08'],
  );
  assert.deepEqual(days[0], {
    key: '2026-11-07',
    average: 22,
    peak: 22,
    minimum: 22,
    samples: [stress(localIso(2026, 11, 7, 15), 22)],
  });
  assert.equal(days[1].average, 48);
  assert.equal(days[1].peak, 90);
  assert.equal(days[1].minimum, 10);
  assert.deepEqual(
    days[1].samples.map((sample) => sample.value),
    [10, 20, 40, 80, 90],
  );
});

test('latest heart rate prefers the newer of the stored log and the probe', () => {
  const stored = { timestamp: '2026-11-08T12:00:00.000Z', bpm: 80 };
  const olderProbe = latestHeartRate({
    heartRate: [stored],
    realtimeHeartRate: 70,
    realtimeHeartRateAt: '2026-11-08T11:00:00.000Z',
  });
  assert.deepEqual(olderProbe, { bpm: 80, timestamp: stored.timestamp });

  const newerProbe = latestHeartRate({
    heartRate: [stored],
    realtimeHeartRate: 90,
    realtimeHeartRateAt: '2026-11-08T13:00:00.000Z',
  });
  assert.deepEqual(newerProbe, { bpm: 90, timestamp: '2026-11-08T13:00:00.000Z' });

  assert.equal(latestHeartRate(null), null);
  assert.equal(latestHeartRate({ heartRate: [], realtimeHeartRate: null, realtimeHeartRateAt: null }), null);
});

test('latest vital skips a spot that is missing the field', () => {
  const spots: VitalSpot[] = [
    { timestamp: '2026-11-08T12:00:00.000Z', spo2: 97, bodyTemperatureC: null },
    { timestamp: '2026-11-08T13:00:00.000Z', spo2: null, bodyTemperatureC: 36.5 },
  ];
  assert.deepEqual(latestVital(spots, 'spo2'), { value: 97, timestamp: '2026-11-08T12:00:00.000Z' });
  assert.deepEqual(latestVital(spots, 'bodyTemperatureC'), { value: 36.5, timestamp: '2026-11-08T13:00:00.000Z' });
  assert.equal(latestVital([], 'spo2'), null);
});

test('latest metric returns the newest finite sample', () => {
  assert.equal(latestMetric([]), null);
  assert.equal(latestMetric(null), null);
  assert.deepEqual(
    latestMetric([
      stress('2026-11-08T15:00:00.000Z', 40),
      stress('2026-11-08T10:00:00.000Z', 10),
      stress('2026-11-08T16:00:00.000Z', Number.NaN),
    ]),
    stress('2026-11-08T15:00:00.000Z', 40),
  );
});

function calendarDay(date: Date, utc: boolean): string {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = utc ? date.getUTCMonth() : date.getMonth();
  const day = utc ? date.getUTCDate() : date.getDate();
  return `${year}-${month}-${day}`;
}
