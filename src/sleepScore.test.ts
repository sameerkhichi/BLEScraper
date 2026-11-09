import assert from 'node:assert/strict';
import test from 'node:test';

import type { SleepNight, SleepStage } from './model';
import {
  annotateSleep,
  architectureScore,
  continuityScore,
  durationScore,
  efficiencyScore,
  endedInDeepSleep,
  scoreSleepNight,
  sleepScoreParts,
} from './sleepScore';

test('duration hits the short and long knots', () => {
  assert.equal(durationScore(0), 0);
  assert.equal(durationScore(4 * 60), 19);
  assert.equal(durationScore(5 * 60), 49);
  assert.equal(durationScore(6 * 60), 79);
  assert.equal(durationScore(7 * 60), 100);
  assert.equal(durationScore(8 * 60), 100);
  assert.equal(durationScore(9 * 60), 100);
  assert.equal(durationScore(10 * 60), 79);
  assert.equal(durationScore(11 * 60), 49);
  assert.equal(durationScore(12 * 60), 19);
  assert.equal(durationScore(13 * 60), 0);
  assert.equal(durationScore(14 * 60), 0);
});

test('efficiency is full at 90 percent, zero at 60, and zero without time in bed', () => {
  assert.equal(efficiencyScore(90, 100), 100);
  assert.equal(efficiencyScore(60, 100), 0);
  assert.equal(efficiencyScore(75, 100), 50);
  assert.equal(efficiencyScore(480, 0), 0);
});

test('the total uses the rescaled weights', () => {
  const night = nightOf({
    minutesAsleep: 8 * 60,
    minutesInBed: 8 * 60,
    minutesLight: 8 * 60,
    minutesDeep: 0,
    minutesRem: 0,
    minutesAwake: 0,
    awakenings: 0,
    stages: [stage('light', 8 * 60)],
  });
  const parts = sleepScoreParts(night);
  const scaled = (parts.duration * 0.3 + parts.efficiency * 0.25 + parts.architecture * 0.25 + parts.continuity * 0.15) / 0.95;
  const unscaled = parts.duration * 0.3 + parts.efficiency * 0.25 + parts.architecture * 0.25 + parts.continuity * 0.15;
  assert.equal(scoreSleepNight(night).score, Math.round(scaled));
  assert.notEqual(Math.round(scaled), Math.round(unscaled));
});

test('a full-credit night scores 100', () => {
  const night = nightOf({
    minutesAsleep: 8 * 60,
    minutesInBed: 8 * 60,
    minutesDeep: 0.18 * 8 * 60,
    minutesRem: 0.22 * 8 * 60,
    minutesLight: 0.6 * 8 * 60,
    minutesAwake: 0,
    awakenings: 0,
    stages: [stage('light', 200), stage('deep', 86), stage('rem', 106), stage('light', 88)],
  });
  const parts = sleepScoreParts(night);
  assert.equal(parts.duration, 100);
  assert.equal(parts.efficiency, 100);
  assert.equal(parts.architecture, 100);
  assert.equal(parts.continuity, 100);
  assert.equal(scoreSleepNight(night).score, 100);
  assert.equal(scoreSleepNight(night).label, 'Excellent');
});

test('ending in deep sleep costs 5 points and trailing awake still counts', () => {
  const lightLast = nightOf({
    minutesAsleep: 480,
    minutesInBed: 480,
    minutesDeep: 100,
    minutesRem: 100,
    minutesLight: 280,
    stages: [stage('deep', 100), stage('rem', 100), stage('light', 280)],
  });
  const deepLast = nightOf({
    ...lightLast,
    stages: [stage('light', 280), stage('rem', 100), stage('deep', 100)],
  });
  const awakeAfterDeep = nightOf({
    ...deepLast,
    minutesInBed: 500,
    minutesAwake: 20,
    awakenings: 1,
    stages: [stage('light', 280), stage('rem', 100), stage('deep', 100), stage('awake', 20)],
  });

  assert.equal(endedInDeepSleep(lightLast.stages), false);
  assert.equal(endedInDeepSleep(deepLast.stages), true);
  assert.equal(endedInDeepSleep(awakeAfterDeep.stages), true);
  assert.equal(scoreSleepNight(lightLast).score - scoreSleepNight(deepLast).score, 5);
});

test('continuity falls off from 20 awake minutes and from two awakenings', () => {
  assert.equal(continuityScore(20, 1), 100);
  assert.equal(continuityScore(60, 6), 0);
  assert.equal(continuityScore(40, 1), 75);
  assert.equal(continuityScore(20, 6), 50);
});

test('architecture stays full inside the band and drops 5 points per point outside', () => {
  assert.equal(
    architectureScore({ minutesAsleep: 100, minutesDeep: 18, minutesRem: 22, minutesLight: 60 }),
    100,
  );
  const justOutside = architectureScore({ minutesAsleep: 100, minutesDeep: 24, minutesRem: 22, minutesLight: 54 });
  assert.equal(justOutside, 0.45 * 95 + 0.45 * 100 + 0.1 * 100);
});

test('extra sleep pays debt down and does not become a credit', () => {
  const short = nightOf({
    startedAt: '2026-11-05T23:00:00.000Z',
    endedAt: '2026-11-06T06:40:00.000Z',
    minutesAsleep: 400,
  });
  const long = nightOf({
    startedAt: '2026-11-06T23:00:00.000Z',
    endedAt: '2026-11-07T09:20:00.000Z',
    minutesAsleep: 560,
  });
  const laterShort = nightOf({
    startedAt: '2026-11-07T23:00:00.000Z',
    endedAt: '2026-11-08T06:00:00.000Z',
    minutesAsleep: 400,
  });

  const newestFirst = annotateSleep([long, short]);
  assert.equal(newestFirst[1]?.sleepDebtMinutes, 80);
  assert.equal(newestFirst[0]?.sleepDebtMinutes, 0);
  assert.equal(newestFirst[0]?.startedAt, long.startedAt);

  const onlyLong = annotateSleep([nightOf({ minutesAsleep: 600 })]);
  assert.equal(onlyLong[0]?.sleepDebtMinutes, 0);

  const afterPayoff = annotateSleep([short, long, laterShort]);
  assert.equal(afterPayoff[2]?.sleepDebtMinutes, 80);
});

function nightOf(patch: Partial<SleepNight> = {}): SleepNight {
  return {
    daysAgo: 0,
    startedAt: '2026-11-05T23:00:00.000Z',
    endedAt: '2026-11-06T07:00:00.000Z',
    minutesAsleep: 480,
    minutesInBed: 480,
    minutesLight: 288,
    minutesDeep: 86,
    minutesRem: 106,
    minutesAwake: 0,
    minutesUnknown: 0,
    awakenings: 0,
    stages: [stage('light', 288)],
    cycles: [],
    ...patch,
  };
}

function stage(name: SleepStage['stage'], minutes: number): SleepStage {
  return { stage: name, minutes, startedAt: '2026-11-05T23:00:00.000Z' };
}
