import assert from 'node:assert/strict';
import test from 'node:test';

import { activityForLocalDay, restingLoad, type HeartRateSample, type SleepNight, type StepSample } from './model';

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

function beat(timestamp: string, bpm: number): HeartRateSample {
  return { timestamp, bpm };
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

test('resting load scores still daytime pulse against the sleep median', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const sleep = [night(localIso(2026, 11, 7, 23), localIso(2026, 11, 8, 7))];
  const asleep = [50, 52, 54, 56, 58, 60].map((bpm, index) =>
    beat(localIso(2026, 11, 7, 23, 10 + index * 30), bpm),
  );
  const still = [0, 5, 10, 15, 20, 25].map((minute) => beat(localIso(2026, 11, 8, 10, minute), 70));
  const walking = [0, 5, 10, 15, 20, 25].map((minute) => beat(localIso(2026, 11, 8, 11, minute), 120));
  const steps = [
    slot(localIso(2026, 11, 8, 10, 0), 0, 0, 0),
    slot(localIso(2026, 11, 8, 10, 15), 29, 0, 0),
    slot(localIso(2026, 11, 8, 11, 0), 80, 0, 0),
    slot(localIso(2026, 11, 8, 11, 15), 30, 0, 0),
  ];

  const load = restingLoad([...asleep, ...still, ...walking], steps, sleep, now);

  assert.deepEqual(load, {
    status: 'scored',
    score: 60,
    band: 'Elevated',
    stillBpm: 70,
    baselineBpm: 55,
    stillMinutes: 30,
  });
});

test('resting load keeps a sample that starts as the sleep window ends', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const sleep = [night(localIso(2026, 11, 7, 23), localIso(2026, 11, 8, 7))];
  const asleep = [50, 52, 54, 56, 58, 60].map((bpm, index) => beat(localIso(2026, 11, 8, 1, index * 5), bpm));
  const duringSleep = beat(localIso(2026, 11, 8, 6, 50), 110);
  const atWake = beat(localIso(2026, 11, 8, 7, 0), 70);
  const later = [5, 10, 15, 20, 25].map((minute) => beat(localIso(2026, 11, 8, 7, minute), 70));
  const steps = [
    slot(localIso(2026, 11, 8, 6, 45), 0, 0, 0),
    slot(localIso(2026, 11, 8, 7, 0), 0, 0, 0),
    slot(localIso(2026, 11, 8, 7, 15), 0, 0, 0),
  ];

  const load = restingLoad([...asleep, duringSleep, atWake, ...later], steps, sleep, now);

  assert.equal(load.status, 'scored');
  if (load.status !== 'scored') return;
  assert.equal(load.stillMinutes, 30);
  assert.equal(load.stillBpm, 70);
  assert.equal(load.baselineBpm, 56);
});

test('resting load uses the previous night when last night is too thin', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const nights = [
    night(localIso(2026, 11, 7, 23), localIso(2026, 11, 8, 7)),
    night(localIso(2026, 11, 6, 23), localIso(2026, 11, 7, 7)),
  ];
  const thin = [70, 72, 74].map((bpm, index) => beat(localIso(2026, 11, 8, 1, index * 10), bpm));
  const earlierNight = [60, 60, 60, 60, 60, 60].map((bpm, index) => beat(localIso(2026, 11, 7, 1, index * 10), bpm));
  const today = [0, 5, 10, 15, 20, 25].map((minute) => beat(localIso(2026, 11, 8, 12, minute), 85));
  const steps = [slot(localIso(2026, 11, 8, 12, 0), 0, 0, 0), slot(localIso(2026, 11, 8, 12, 15), 0, 0, 0)];

  const load = restingLoad([...thin, ...earlierNight, ...today], steps, nights, now);

  assert.equal(load.status, 'scored');
  if (load.status !== 'scored') return;
  assert.equal(load.baselineBpm, 60);
  assert.equal(load.score, 100);
  assert.equal(load.band, 'High');
});

test('resting load falls back to earlier still days when no night has enough pulse samples', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const yesterday = [0, 5, 10, 15, 20, 25].map((minute) => beat(localIso(2026, 11, 7, 15, minute), 62));
  const today = [0, 5, 10, 15, 20, 25].map((minute) => beat(localIso(2026, 11, 8, 15, minute), 72));
  const steps = [
    slot(localIso(2026, 11, 7, 15, 0), 0, 0, 0),
    slot(localIso(2026, 11, 7, 15, 15), 0, 0, 0),
    slot(localIso(2026, 11, 8, 15, 0), 0, 0, 0),
    slot(localIso(2026, 11, 8, 15, 15), 0, 0, 0),
  ];

  const load = restingLoad([...yesterday, ...today], steps, [], now);

  assert.deepEqual(load, {
    status: 'scored',
    score: 40,
    band: 'Mild',
    stillBpm: 72,
    baselineBpm: 62,
    stillMinutes: 30,
  });
});

test('resting load asks for still time once a baseline exists', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const sleep = [night(localIso(2026, 11, 7, 23), localIso(2026, 11, 8, 7))];
  const asleep = [50, 52, 54, 56, 58, 60].map((bpm, index) => beat(localIso(2026, 11, 8, 2, index), bpm));
  const today = [0, 5, 10, 15, 20].map((minute) => beat(localIso(2026, 11, 8, 9, minute), 70));
  const steps = [slot(localIso(2026, 11, 8, 9, 0), 0, 0, 0), slot(localIso(2026, 11, 8, 9, 15), 0, 0, 0)];

  assert.deepEqual(restingLoad([...asleep, ...today], steps, sleep, now), { status: 'need-still' });
});

test('resting load asks for a heart-rate baseline when neither night nor earlier still days qualify', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const today = [0, 5, 10, 15, 20, 25].map((minute) => beat(localIso(2026, 11, 8, 9, minute), 70));
  const steps = [slot(localIso(2026, 11, 8, 9, 0), 0, 0, 0), slot(localIso(2026, 11, 8, 9, 15), 0, 0, 0)];

  assert.deepEqual(restingLoad(today, steps, [], now), { status: 'need-baseline' });
  assert.deepEqual(restingLoad([], [], [], now), { status: 'need-baseline' });
});

test('resting load bands follow the rounded day score', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const sleep = [night(localIso(2026, 11, 7, 23), localIso(2026, 11, 8, 7))];
  const asleep = [50, 50, 50, 50, 50, 50].map((bpm, index) => beat(localIso(2026, 11, 8, 1, index), bpm));
  const steps = [slot(localIso(2026, 11, 8, 10, 0), 0, 0, 0), slot(localIso(2026, 11, 8, 10, 15), 0, 0, 0)];

  const scoreFor = (bpm: number[]) => {
    const today = bpm.map((value, index) => beat(localIso(2026, 11, 8, 10, index * 5), value));
    const load = restingLoad([...asleep, ...today], steps, sleep, now);
    assert.equal(load.status, 'scored');
    if (load.status !== 'scored') return null;
    return { score: load.score, band: load.band };
  };

  assert.deepEqual(scoreFor([56, 56, 56, 56, 56, 56]), { score: 24, band: 'Resting' });
  assert.deepEqual(scoreFor([56, 56, 56, 56, 56, 57]), { score: 25, band: 'Mild' });
  assert.deepEqual(scoreFor([62, 62, 62, 63, 63, 63]), { score: 50, band: 'Elevated' });
  assert.deepEqual(scoreFor([68, 68, 68, 69, 69, 69]), { score: 74, band: 'Elevated' });
  assert.deepEqual(scoreFor([68, 68, 69, 69, 69, 69]), { score: 75, band: 'High' });
  assert.deepEqual(scoreFor([90, 90, 90, 90, 90, 90]), { score: 100, band: 'High' });
});

test('resting load rounds an even sleep median before scoring', () => {
  const now = new Date(2026, 10, 8, 18, 0, 0);
  const sleep = [night(localIso(2026, 11, 7, 23), localIso(2026, 11, 8, 7))];
  const asleep = [50, 52, 54, 57, 58, 60].map((bpm, index) => beat(localIso(2026, 11, 8, 1, index), bpm));
  const today = [0, 5, 10, 15, 20, 25].map((minute) => beat(localIso(2026, 11, 8, 10, minute), 56));
  const steps = [slot(localIso(2026, 11, 8, 10, 0), 0, 0, 0), slot(localIso(2026, 11, 8, 10, 15), 0, 0, 0)];

  const load = restingLoad([...asleep, ...today], steps, sleep, now);

  assert.equal(load.status, 'scored');
  if (load.status !== 'scored') return;
  assert.equal(load.baselineBpm, 56);
  assert.equal(load.score, 0);
  assert.equal(load.band, 'Resting');
});

function calendarDay(date: Date, utc: boolean): string {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = utc ? date.getUTCMonth() : date.getMonth();
  const day = utc ? date.getUTCDate() : date.getDate();
  return `${year}-${month}-${day}`;
}
