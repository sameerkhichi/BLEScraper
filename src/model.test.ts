import assert from 'node:assert/strict';
import test from 'node:test';

import { activityForLocalDay, type StepSample } from './model';

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

function calendarDay(date: Date, utc: boolean): string {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = utc ? date.getUTCMonth() : date.getMonth();
  const day = utc ? date.getUTCDate() : date.getDate();
  return `${year}-${month}-${day}`;
}
