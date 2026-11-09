export const RING_HEART_RATE_MINUTES = 5;

export type RingChecks = {
  heartRate: boolean;
  heartRateMinutes: number;
  spo2: boolean;
  stress: boolean;
  hrv: boolean;
};

export const defaultRingChecks: RingChecks = {
  heartRate: true,
  heartRateMinutes: RING_HEART_RATE_MINUTES,
  spo2: true,
  stress: true,
  hrv: true,
};

export type AppSettings = {
  apiUrl: string;
  apiKey: string;
  ringId: string | null;
  ringName: string | null;
  autoSync: boolean;
  // The ring's own wave detector. Phone-side poses do not use it.
  factoryGestures: boolean;
  ringChecks: RingChecks;
};

export type BatteryReading = {
  level: number;
  charging: boolean;
};

export type HeartRateSample = {
  timestamp: string;
  bpm: number;
};

export type MetricSample = {
  timestamp: string;
  value: number;
};

export type VitalSpot = {
  timestamp: string;
  spo2: number | null;
  bodyTemperatureC: number | null;
};

// The ring does not keep these. The phone remembers each wake's spot long enough
// for a later snapshot to still include it.
export const VITAL_SPOT_RETAIN_MS = 10 * 24 * 60 * 60 * 1000;

export type StepSample = {
  timestamp: string;
  steps: number;
  calories: number;
  distanceMeters: number;
};

export type LocalDayActivity = {
  steps: number;
  calories: number;
  distanceMeters: number;
};

// Slots are stored as UTC instants. Today is the phone's calendar day, so a late
// local evening still counts after its UTC date has rolled over.
export function activityForLocalDay(steps: StepSample[], now = new Date()): LocalDayActivity {
  const total: LocalDayActivity = { steps: 0, calories: 0, distanceMeters: 0 };
  for (const sample of steps) {
    if (!isSameLocalDay(sample.timestamp, now)) continue;
    total.steps += sample.steps;
    total.calories += sample.calories;
    total.distanceMeters += sample.distanceMeters;
  }
  return total;
}

function isSameLocalDay(timestamp: string, now: Date): boolean {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return false;
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

const STEP_BLOCK_MS = 15 * 60 * 1000;
const STILL_STEP_LIMIT = 30;
const RESTING_MIN_SAMPLES = 6;
const RESTING_SLOT_MINUTES = 5;
// A slot 25 bpm above the sleep median fills the scale.
const RESTING_FULL_EXCESS = 25;

export type RestingLoadBand = 'Resting' | 'Mild' | 'Elevated' | 'High';

export type RestingLoad =
  | {
      status: 'scored';
      score: number;
      band: RestingLoadBand;
      stillBpm: number;
      baselineBpm: number;
      stillMinutes: number;
    }
  | { status: 'need-still' }
  | { status: 'need-baseline' };

// Daytime stress stand-in: still pulse against the sleep median. The ring stores
// one BPM per slot, so this is resting load rather than heart-rate variability.
export function restingLoad(
  heartRate: HeartRateSample[],
  steps: StepSample[],
  sleep: SleepNight[],
  now = new Date(),
): RestingLoad {
  const baseline = sleepBaseline(heartRate, steps, sleep, now);
  if (baseline === null) return { status: 'need-baseline' };

  const still = stillBpm(heartRate, steps, sleep, now, true);
  if (still.length < RESTING_MIN_SAMPLES) return { status: 'need-still' };

  const slots = still.map((bpm) => Math.min(100, (Math.max(0, bpm - baseline) / RESTING_FULL_EXCESS) * 100));
  const score = Math.round(slots.reduce((sum, value) => sum + value, 0) / slots.length);
  return {
    status: 'scored',
    score,
    band: restingBand(score),
    stillBpm: Math.round(still.reduce((sum, bpm) => sum + bpm, 0) / still.length),
    baselineBpm: baseline,
    stillMinutes: still.length * RESTING_SLOT_MINUTES,
  };
}

function restingBand(score: number): RestingLoadBand {
  if (score <= 24) return 'Resting';
  if (score <= 49) return 'Mild';
  if (score <= 74) return 'Elevated';
  return 'High';
}

function sleepBaseline(
  heartRate: HeartRateSample[],
  steps: StepSample[],
  sleep: SleepNight[],
  now: Date,
): number | null {
  const nights = [...sleep].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  for (const night of nights) {
    const start = Date.parse(night.startedAt);
    const end = Date.parse(night.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const bpm = heartRateBpm(heartRate, (time) => time >= start && time < end);
    if (bpm.length >= RESTING_MIN_SAMPLES) return roundedMedian(bpm);
  }

  const earlier = stillBpm(heartRate, steps, sleep, now, false);
  if (earlier.length < RESTING_MIN_SAMPLES) return null;
  return roundedMedian(earlier);
}

function stillBpm(
  heartRate: HeartRateSample[],
  steps: StepSample[],
  sleep: SleepNight[],
  now: Date,
  today: boolean,
): number[] {
  return heartRateBpm(heartRate, (time, timestamp) => {
    if (isSameLocalDay(timestamp, now) !== today) return false;
    if (insideSleep(sleep, time)) return false;
    return isStill(steps, time);
  });
}

function heartRateBpm(
  heartRate: HeartRateSample[],
  include: (time: number, timestamp: string) => boolean,
): number[] {
  const bpm: number[] = [];
  for (const sample of heartRate) {
    const time = Date.parse(sample.timestamp);
    if (!Number.isFinite(time) || !Number.isFinite(sample.bpm) || sample.bpm <= 0) continue;
    if (!include(time, sample.timestamp)) continue;
    bpm.push(sample.bpm);
  }
  return bpm;
}

function insideSleep(sleep: SleepNight[], time: number): boolean {
  return sleep.some((night) => {
    const start = Date.parse(night.startedAt);
    const end = Date.parse(night.endedAt);
    return Number.isFinite(start) && Number.isFinite(end) && time >= start && time < end;
  });
}

function isStill(steps: StepSample[], time: number): boolean {
  let stepsInBlock: number | null = null;
  let blockStart = -Infinity;
  for (const sample of steps) {
    const start = Date.parse(sample.timestamp);
    if (!Number.isFinite(start) || time < start || time >= start + STEP_BLOCK_MS) continue;
    if (start < blockStart) continue;
    blockStart = start;
    stepsInBlock = sample.steps;
  }
  return stepsInBlock !== null && stepsInBlock < STILL_STEP_LIMIT;
}

function roundedMedian(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(median);
}

export type AccelReading = {
  x: number;
  y: number;
  z: number;
};

export type AccelSample = AccelReading & {
  sampledAt: string;
};

export type ScanKind = 'heart-rate' | 'spo2' | 'temperature' | 'all';

export type SleepStageName = 'light' | 'deep' | 'rem' | 'awake' | 'unknown';

export type SleepStage = {
  stage: SleepStageName;
  minutes: number;
  startedAt: string;
};

export type SleepCycle = {
  index: number;
  startedAt: string;
  endedAt: string;
  minutes: number;
  complete: boolean;
};

export type SleepNight = {
  daysAgo: number;
  startedAt: string;
  endedAt: string;
  minutesAsleep: number;
  minutesInBed: number;
  minutesLight: number;
  minutesDeep: number;
  minutesRem: number;
  minutesAwake: number;
  minutesUnknown: number;
  awakenings: number;
  stages: SleepStage[];
  cycles: SleepCycle[];
};

export type UploadPayload = {
  source: 'colmi-r09';
  syncedAt: string;
  ring: {
    id: string;
    name: string | null;
  };
  battery: BatteryReading | null;
  realtimeHeartRate: number | null;
  realtimeHeartRateAt?: string | null;
  spo2: number | null;
  bodyTemperatureC: number | null;
  vitalSpots: VitalSpot[];
  accelerometer: AccelSample | null;
  heartRate: HeartRateSample[];
  steps: StepSample[];
  stress: MetricSample[];
  hrv: MetricSample[];
  sleep: SleepNight[];
  warnings: string[];
};

export function isAccelSample(value: unknown): value is AccelSample {
  if (!value || typeof value !== 'object') return false;
  const sample = value as AccelSample;
  return (
    typeof sample.x === 'number' &&
    typeof sample.y === 'number' &&
    typeof sample.z === 'number' &&
    typeof sample.sampledAt === 'string'
  );
}

export function isSleepNight(value: unknown): value is SleepNight {
  if (!value || typeof value !== 'object') return false;
  const night = value as SleepNight;
  return (
    typeof night.daysAgo === 'number' &&
    typeof night.startedAt === 'string' &&
    typeof night.endedAt === 'string' &&
    typeof night.minutesAsleep === 'number' &&
    Array.isArray(night.stages) &&
    Array.isArray(night.cycles)
  );
}

export function vitalSpot(
  spo2: number | null,
  bodyTemperatureC: number | null,
  timestamp = new Date().toISOString(),
): VitalSpot | null {
  if (typeof spo2 !== 'number' && typeof bodyTemperatureC !== 'number') return null;
  return { timestamp, spo2, bodyTemperatureC };
}

export function isMetricSample(value: unknown): value is MetricSample {
  if (!value || typeof value !== 'object') return false;
  const sample = value as MetricSample;
  return typeof sample.timestamp === 'string' && Number.isFinite(Date.parse(sample.timestamp)) && typeof sample.value === 'number';
}

export function mergeVitalSpots(spots: VitalSpot[]): VitalSpot[] {
  const byTime = new Map<string, VitalSpot>();
  for (const spot of spots) {
    const existing = byTime.get(spot.timestamp);
    if (!existing) {
      byTime.set(spot.timestamp, spot);
      continue;
    }
    byTime.set(spot.timestamp, {
      timestamp: spot.timestamp,
      spo2: spot.spo2 ?? existing.spo2,
      bodyTemperatureC: spot.bodyTemperatureC ?? existing.bodyTemperatureC,
    });
  }
  return [...byTime.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function isVitalSpot(value: unknown): value is VitalSpot {
  if (!value || typeof value !== 'object') return false;
  const spot = value as VitalSpot;
  const spo2 = spot.spo2 === null || typeof spot.spo2 === 'number';
  const temperature = spot.bodyTemperatureC === null || typeof spot.bodyTemperatureC === 'number';
  return (
    typeof spot.timestamp === 'string' &&
    Number.isFinite(Date.parse(spot.timestamp)) &&
    spo2 &&
    temperature &&
    (typeof spot.spo2 === 'number' || typeof spot.bodyTemperatureC === 'number')
  );
}

export function keepStoredSamples(
  previous: UploadPayload | null,
  next: UploadPayload,
  now = Date.now(),
): UploadPayload {
  const vitalSpots = pruneVitalSpots(mergeVitalSpots([...(previous?.vitalSpots ?? []), ...(next.vitalSpots ?? [])]), now);
  if (!previous) return { ...next, vitalSpots, stress: next.stress ?? [], hrv: next.hrv ?? [] };
  return {
    ...next,
    heartRate: unionByTimestamp(previous.heartRate, next.heartRate),
    steps: unionByTimestamp(previous.steps, next.steps),
    stress: unionByTimestamp(previous.stress ?? [], next.stress ?? []),
    hrv: unionByTimestamp(previous.hrv ?? [], next.hrv ?? []),
    vitalSpots,
  };
}

function pruneVitalSpots(spots: VitalSpot[], now: number): VitalSpot[] {
  const cutoff = now - VITAL_SPOT_RETAIN_MS;
  return spots.filter((spot) => {
    const time = Date.parse(spot.timestamp);
    return Number.isFinite(time) && time >= cutoff;
  });
}

function unionByTimestamp<T extends { timestamp: string }>(previous: T[], next: T[]): T[] {
  const byTime = new Map<string, T>();
  for (const sample of previous) byTime.set(sample.timestamp, sample);
  for (const sample of next) byTime.set(sample.timestamp, sample);
  return [...byTime.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

// Sleep can arrive without a new heart-rate or step log. Keep the samples already stored.
export function keepSleepRecord(previous: UploadPayload | null, incoming: UploadPayload): UploadPayload {
  if (!previous) return incoming;
  return {
    ...previous,
    syncedAt: incoming.syncedAt,
    sleep: incoming.sleep,
  };
}

export function mergeReadings(
  previous: UploadPayload | null,
  next: UploadPayload,
  keepHistory: boolean,
): UploadPayload {
  if (!previous) return next;
  return {
    ...next,
    battery: next.battery ?? previous.battery,
    realtimeHeartRate: next.realtimeHeartRate ?? previous.realtimeHeartRate,
    realtimeHeartRateAt:
      typeof next.realtimeHeartRate === 'number'
        ? next.realtimeHeartRateAt ?? next.syncedAt
        : previous.realtimeHeartRateAt ?? null,
    spo2: next.spo2 ?? previous.spo2,
    bodyTemperatureC: next.bodyTemperatureC ?? previous.bodyTemperatureC,
    vitalSpots: pruneVitalSpots(mergeVitalSpots([...(previous.vitalSpots ?? []), ...(next.vitalSpots ?? [])]), Date.now()),
    accelerometer: next.accelerometer ?? previous.accelerometer,
    heartRate: keepHistory ? previous.heartRate : next.heartRate,
    steps: keepHistory ? previous.steps : next.steps,
    stress: keepHistory ? (previous.stress ?? []) : (next.stress ?? []),
    hrv: keepHistory ? (previous.hrv ?? []) : (next.hrv ?? []),
    sleep: keepHistory ? previous.sleep : next.sleep,
  };
}

export const defaultSettings: AppSettings = {
  apiUrl: '',
  apiKey: '',
  ringId: null,
  ringName: null,
  autoSync: true,
  factoryGestures: false,
  ringChecks: defaultRingChecks,
};
