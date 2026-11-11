import {
  activityHistoryDays,
  heartRateHistoryDays,
  spo2HistoryDays,
  stressDayKey,
  stressHistoryDays,
  stressSummary,
  temperatureHistoryDays,
  type AppSettings,
  type ProcessedWindow,
  type SleepNight,
  type UploadPayload,
} from '../model';
import { annotateSleep, type ScoredSleepNight, type SleepScoreLabel } from '../sleepScore';

export type ProcessedDay = {
  key: string;
  average: number;
  peak: number;
  minimum: number;
};

export type ProcessedActivityDay = {
  key: string;
  steps: number;
  calories: number;
  distanceMeters: number;
};

export type ProcessedSleepNight = {
  startedAt: string;
  endedAt: string;
  score: number;
  scoreLabel: SleepScoreLabel;
  endedInDeepSleep: boolean;
  sleepDebtMinutes: number;
};

export type ProcessedSummary = {
  window: ProcessedWindow;
  heartRate: ProcessedDay[];
  spo2: ProcessedDay[];
  temperature: ProcessedDay[];
  activity: ProcessedActivityDay[];
  stress: {
    current: { value: number; band: string; timestamp: string } | null;
    average: number | null;
    peak: number | null;
    highMinutes: number;
    distribution: { Relaxed: number; Low: number; Moderate: number; High: number };
    trend: string | null;
    overnight: number | null;
    week: { value: number; days: number } | null;
    month: { value: number; days: number } | null;
    days: ProcessedDay[];
  };
  sleep: {
    debtMinutes: number | null;
    nights: ProcessedSleepNight[];
  };
};

export type UploadBody = Record<string, unknown>;

export function shapeUpload(settings: AppSettings, payload: UploadPayload, now = new Date()): UploadBody {
  const raw = rawBody(payload);
  const mode = settings.uploadMode ?? 'raw';
  if (mode === 'raw') return raw;
  const processed = processedSummary(payload, settings.processedWindow ?? 'all', now);
  if (mode === 'processed') {
    return {
      source: payload.source,
      syncedAt: payload.syncedAt,
      ring: payload.ring,
      processed,
    };
  }
  return { ...raw, processed };
}

export function processedSummary(payload: UploadPayload, window: ProcessedWindow, now = new Date()): ProcessedSummary {
  const keys = dayKeys(window, now);
  const range = windowRange(window, now);
  const summary = stressSummary(payload.stress ?? [], payload.sleep ?? [], now);
  const scored = annotateSleep(payload.sleep ?? []);
  const nights = scored.filter((night) => overlaps(night, range));
  const newest = [...nights].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];

  return {
    window,
    heartRate: daysIn(heartRateHistoryDays(payload.heartRate ?? []), keys),
    spo2: daysIn(spo2HistoryDays(payload.vitalSpots ?? []), keys),
    temperature: daysIn(temperatureHistoryDays(payload.vitalSpots ?? []), keys),
    activity: activityHistoryDays(payload.steps ?? [])
      .filter((day) => !keys || keys.has(day.key))
      .map(({ key, steps, calories, distanceMeters }) => ({ key, steps, calories, distanceMeters })),
    stress: {
      current: summary.current,
      average: summary.average,
      peak: summary.peak,
      highMinutes: summary.highMinutes,
      distribution: summary.distribution,
      trend: summary.trend,
      overnight: summary.overnight,
      week: summary.week,
      month: summary.month,
      days: daysIn(stressHistoryDays(payload.stress ?? [], payload.sleep ?? []), keys),
    },
    sleep: {
      debtMinutes: newest ? newest.sleepDebtMinutes : null,
      nights: nights.map(scoredNight),
    },
  };
}

function rawBody(payload: UploadPayload): UploadBody {
  return {
    ...payload,
    sleep: payload.sleep.length === 0 ? [] : annotateSleep(payload.sleep),
  };
}

function daysIn(rows: Array<{ key: string; average: number; peak: number; minimum: number }>, keys: Set<string> | null): ProcessedDay[] {
  return rows.filter((day) => !keys || keys.has(day.key)).map(({ key, average, peak, minimum }) => ({ key, average, peak, minimum }));
}

function dayKeys(window: ProcessedWindow, now: Date): Set<string> | null {
  if (window === 'all') return null;
  const span = window === 'day' ? 1 : 7;
  const keys = new Set<string>();
  for (let ago = 0; ago < span; ago += 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - ago);
    const key = stressDayKey(date);
    if (key) keys.add(key);
  }
  return keys;
}

function windowRange(window: ProcessedWindow, now: Date): { start: number; end: number } | null {
  if (window === 'all') return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (window === 'week') start.setDate(start.getDate() - 6);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function overlaps(night: SleepNight, range: { start: number; end: number } | null): boolean {
  if (!range) return true;
  const began = Date.parse(night.startedAt);
  const finished = Date.parse(night.endedAt);
  if (!Number.isFinite(began) || !Number.isFinite(finished)) return false;
  return began < range.end && finished > range.start;
}

function scoredNight(night: ScoredSleepNight): ProcessedSleepNight {
  return {
    startedAt: night.startedAt,
    endedAt: night.endedAt,
    score: night.score,
    scoreLabel: night.scoreLabel,
    endedInDeepSleep: night.endedInDeepSleep,
    sleepDebtMinutes: night.sleepDebtMinutes,
  };
}

export async function postPayload(settings: AppSettings, payload: UploadPayload, now = new Date()): Promise<void> {
  const url = settings.apiUrl.trim();
  if (!url) {
    throw new Error('Add the Arduino URL in Settings.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The API URL is not valid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The API URL needs to start with http:// or https://.');
  }

  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain',
    'Content-Type': 'application/json',
  };
  if (settings.apiKey.trim()) {
    headers['X-Api-Key'] = settings.apiKey.trim();
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(shapeUpload(settings, payload, now)),
  });
  if (!response.ok) {
    throw new Error(`The server responded with ${response.status}.`);
  }
}
