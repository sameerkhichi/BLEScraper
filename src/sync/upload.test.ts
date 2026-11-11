import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultSettings,
  processedWindowFrom,
  stressDayKey,
  uploadModeFrom,
  type AppSettings,
  type SleepNight,
  type SleepStage,
  type UploadPayload,
} from '../model';
import { annotateSleep } from '../sleepScore';
import { enqueue, flushQueue } from './queue';
import { postPayload, shapeUpload, type ProcessedSummary } from './upload';

const now = new Date(2026, 10, 10, 15, 0, 0);

function at(dayOffset: number, hours: number, minutes = 0): string {
  const date = new Date(now);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function key(dayOffset: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() + dayOffset);
  const day = stressDayKey(date);
  if (!day) throw new Error('missing day');
  return day;
}

function stage(name: SleepStage['stage'], minutes: number, startedAt: string): SleepStage {
  return { stage: name, minutes, startedAt };
}

function night(startedAt: string, endedAt: string, minutesAsleep: number): SleepNight {
  return {
    daysAgo: 0,
    startedAt,
    endedAt,
    minutesAsleep,
    minutesInBed: 8 * 60,
    minutesLight: minutesAsleep,
    minutesDeep: 0,
    minutesRem: 0,
    minutesAwake: 0,
    minutesUnknown: 0,
    awakenings: 0,
    stages: [stage('light', minutesAsleep, startedAt)],
    cycles: [],
  };
}

function reading(): UploadPayload {
  const todayNight = night(at(-1, 22), at(0, 6), 400);
  const oldNight = night(at(-8, 22), at(-7, 6), 0);
  return {
    source: 'colmi-r09',
    syncedAt: at(0, 15),
    ring: { id: 'ring', name: 'R09' },
    battery: { level: 80, charging: false },
    realtimeHeartRate: 72,
    spo2: 98,
    bodyTemperatureC: 36.6,
    vitalSpots: [{ timestamp: at(0, 14), spo2: 98, bodyTemperatureC: 36.6 }],
    accelerometer: null,
    heartRate: [
      { timestamp: at(0, 9), bpm: 60 },
      { timestamp: at(0, 10), bpm: 80 },
      { timestamp: at(-6, 9), bpm: 50 },
      { timestamp: at(-7, 9), bpm: 40 },
    ],
    steps: [
      { timestamp: at(0, 9), steps: 10, calories: 1, distanceMeters: 8 },
      { timestamp: at(-6, 9), steps: 5, calories: 1, distanceMeters: 4 },
      { timestamp: at(-7, 9), steps: 1, calories: 0, distanceMeters: 1 },
    ],
    stress: [
      { timestamp: at(0, 10), value: 20 },
      { timestamp: at(0, 12), value: 40 },
    ],
    hrv: [],
    sleep: [todayNight, oldNight],
    warnings: [],
  };
}

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultSettings, apiUrl: 'http://203.0.113.10:8080/ingest', apiKey: 'secret', ...patch };
}

function summary(body: { processed?: ProcessedSummary }): ProcessedSummary {
  if (!body.processed) throw new Error('missing processed summary');
  return body.processed;
}

test('a missing upload choice stays raw and all', () => {
  assert.equal(uploadModeFrom(undefined), 'raw');
  assert.equal(uploadModeFrom('later'), 'raw');
  assert.equal(processedWindowFrom(undefined), 'all');
  assert.equal(processedWindowFrom('month'), 'all');
  assert.equal(uploadModeFrom('processed'), 'processed');
  assert.equal(processedWindowFrom('week'), 'week');
});

test('raw matches the sample JSON and leaves the summary off', () => {
  const payload = reading();
  const body = shapeUpload(settings({ uploadMode: 'raw', processedWindow: 'day' }), payload, now);

  assert.equal('processed' in body, false);
  assert.deepEqual(body.heartRate, payload.heartRate);
  assert.deepEqual(body.sleep, annotateSleep(payload.sleep));
  assert.equal(body.realtimeHeartRate, 72);
});

test('processed sends the summary for today and leaves the sample arrays out', () => {
  const body = shapeUpload(settings({ uploadMode: 'processed', processedWindow: 'day' }), reading(), now);
  const processed = summary(body);

  assert.deepEqual(Object.keys(body).sort(), ['processed', 'ring', 'source', 'syncedAt']);
  assert.equal(processed.window, 'day');
  assert.deepEqual(processed.heartRate, [{ key: key(0), average: 70, peak: 80, minimum: 60 }]);
  assert.deepEqual(processed.spo2, [{ key: key(0), average: 98, peak: 98, minimum: 98 }]);
  assert.deepEqual(processed.temperature, [{ key: key(0), average: 36.6, peak: 36.6, minimum: 36.6 }]);
  assert.deepEqual(processed.activity, [{ key: key(0), steps: 10, calories: 1, distanceMeters: 8 }]);
  assert.equal(processed.stress.average, 30);
  assert.equal(processed.stress.peak, 40);
  assert.deepEqual(processed.stress.distribution, { Relaxed: 50, Low: 50, Moderate: 0, High: 0 });
  assert.equal('today' in processed.stress, false);
  assert.equal('samples' in processed.heartRate[0], false);
  assert.deepEqual(processed.stress.days, [{ key: key(0), average: 30, peak: 40, minimum: 20 }]);
  assert.equal(processed.sleep.nights.length, 1);
  assert.equal(processed.sleep.nights[0].startedAt, at(-1, 22));
  assert.equal(typeof processed.sleep.nights[0].score, 'number');
  assert.equal(processed.sleep.debtMinutes, processed.sleep.nights[0].sleepDebtMinutes);
  assert.equal(processed.sleep.debtMinutes, 560);
});

test('this week keeps six days back and drops the day before that', () => {
  const body = shapeUpload(settings({ uploadMode: 'processed', processedWindow: 'week' }), reading(), now);
  const processed = summary(body);

  assert.deepEqual(
    processed.heartRate.map((day) => day.key),
    [key(-6), key(0)],
  );
  assert.deepEqual(
    processed.activity.map((day) => day.key),
    [key(-6), key(0)],
  );
  assert.equal(processed.sleep.nights.length, 1);
  assert.equal(processed.sleep.debtMinutes, 560);
});

test('all keeps every stored day and both adds that summary to the sample JSON', () => {
  const payload = reading();
  const processedOnly = summary(shapeUpload(settings({ uploadMode: 'processed', processedWindow: 'all' }), payload, now));
  const both = shapeUpload(settings({ uploadMode: 'both', processedWindow: 'all' }), payload, now);

  assert.deepEqual(
    processedOnly.heartRate.map((day) => day.key),
    [key(-7), key(-6), key(0)],
  );
  assert.equal(processedOnly.sleep.nights.length, 2);
  assert.deepEqual(both.heartRate, payload.heartRate);
  assert.deepEqual(both.sleep, annotateSleep(payload.sleep));
  assert.deepEqual(both.processed, processedOnly);
});

test('an IP URL and an https URL post the chosen JSON', async () => {
  const payload = reading();
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  try {
    const rawSettings = settings({ uploadMode: 'raw' });
    await postPayload(rawSettings, payload, now);
    const httpsSettings = settings({
      apiUrl: 'https://api.example.com/ingest',
      uploadMode: 'processed',
      processedWindow: 'day',
    });
    await postPayload(httpsSettings, payload, now);
    await postPayload(settings({ apiUrl: 'https://api.example.com/both', apiKey: '', uploadMode: 'both' }), payload, now);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://203.0.113.10:8080/ingest');
  assert.equal(calls[0].init.method, 'POST');
  const rawHeaders = calls[0].init.headers as Record<string, string>;
  assert.equal(rawHeaders['Content-Type'], 'application/json');
  assert.equal(rawHeaders['X-Api-Key'], 'secret');
  const rawBody = JSON.parse(String(calls[0].init.body));
  assert.equal('processed' in rawBody, false);
  assert.equal(rawBody.heartRate.length, 4);
  assert.equal(rawBody.sleep[0].score !== undefined, true);

  const processedBody = JSON.parse(String(calls[1].init.body));
  assert.deepEqual(Object.keys(processedBody).sort(), ['processed', 'ring', 'source', 'syncedAt']);
  assert.equal(processedBody.processed.heartRate[0].average, 70);

  const bothHeaders = calls[2].init.headers as Record<string, string>;
  assert.equal(bothHeaders['X-Api-Key'], undefined);
  const bothBody = JSON.parse(String(calls[2].init.body));
  assert.equal(bothBody.heartRate.length, 4);
  assert.equal(bothBody.processed.window, 'all');
});

test('a blank URL, a URL with no scheme, and a failed response are not sent', async () => {
  const payload = reading();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('no', { status: 503 });
  }) as typeof fetch;

  try {
    await assert.rejects(postPayload(settings({ apiUrl: '   ' }), payload, now), /Arduino URL/);
    await assert.rejects(postPayload(settings({ apiUrl: '203.0.113.10:8080/ingest' }), payload, now), /not valid/);
    assert.equal(calls, 0);
    await assert.rejects(postPayload(settings(), payload, now), /503/);
    assert.equal(calls, 1);

    const result = await flushQueue(enqueue([], payload), (body) => postPayload(settings(), body, now));
    assert.equal(result.sent, 0);
    assert.equal(result.remaining.length, 1);
    assert.equal(result.remaining[0].payload.realtimeHeartRate, 72);
  } finally {
    globalThis.fetch = original;
  }
});
