export type AppSettings = {
  apiUrl: string;
  apiKey: string;
  ringId: string | null;
  ringName: string | null;
  autoSync: boolean;
};

export type BatteryReading = {
  level: number;
  charging: boolean;
};

export type HeartRateSample = {
  timestamp: string;
  bpm: number;
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
  const vitalSpots = pruneVitalSpots(
    previous ? unionByTimestamp(previous.vitalSpots ?? [], next.vitalSpots ?? []) : (next.vitalSpots ?? []),
    now,
  );
  if (!previous) return { ...next, vitalSpots };
  return {
    ...next,
    heartRate: unionByTimestamp(previous.heartRate, next.heartRate),
    steps: unionByTimestamp(previous.steps, next.steps),
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
    vitalSpots: pruneVitalSpots(unionByTimestamp(previous.vitalSpots ?? [], next.vitalSpots ?? []), Date.now()),
    accelerometer: next.accelerometer ?? previous.accelerometer,
    heartRate: keepHistory ? previous.heartRate : next.heartRate,
    steps: keepHistory ? previous.steps : next.steps,
    sleep: keepHistory ? previous.sleep : next.sleep,
  };
}

export const defaultSettings: AppSettings = {
  apiUrl: '',
  apiKey: '',
  ringId: null,
  ringName: null,
  autoSync: true,
};
