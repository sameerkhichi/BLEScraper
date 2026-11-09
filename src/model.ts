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

const STRESS_BANDS = ['Relaxed', 'Low', 'Moderate', 'High'] as const;
const STRESS_HIGH = 75;
const STRESS_TREND_MS = 3 * 60 * 60 * 1000;
const STRESS_TREND_GAP = 5;
const STRESS_HIGH_CAP_MS = 60 * 60 * 1000;
const STRESS_LAST_SLOT_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StressBand = (typeof STRESS_BANDS)[number];
export type StressTrend = 'Rising' | 'Falling' | 'Steady';

export type StressBaseline = {
  value: number;
  days: number;
};

export type StressDistribution = Record<StressBand, number>;

export type StressSummary = {
  current: { value: number; band: StressBand; timestamp: string } | null;
  today: MetricSample[];
  average: number | null;
  peak: number | null;
  highMinutes: number;
  distribution: StressDistribution;
  trend: StressTrend | null;
  week: StressBaseline | null;
  month: StressBaseline | null;
  overnight: number | null;
};

// Labels for the ring's own 0–99 estimate. They are not the ring's categories.
export function stressBand(value: number): StressBand {
  if (value <= 24) return 'Relaxed';
  if (value <= 49) return 'Low';
  if (value <= 74) return 'Moderate';
  return 'High';
}

// Daytime samples are the ones outside every sleep window. Overnight stays separate.
export function stressSummary(samples: MetricSample[], sleep: SleepNight[], now = new Date()): StressSummary {
  const usable = samples
    .filter((sample) => {
      const time = Date.parse(sample.timestamp);
      return Number.isFinite(time) && sample.value >= 1 && sample.value <= 99;
    })
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const today = usable.filter(
    (sample) => isSameLocalDay(sample.timestamp, now) && !insideSleep(sleep, Date.parse(sample.timestamp)),
  );
  const current = today.at(-1) ?? null;
  const values = today.map((sample) => sample.value);

  return {
    current: current ? { value: current.value, band: stressBand(current.value), timestamp: current.timestamp } : null,
    today,
    average: values.length === 0 ? null : Math.round(mean(values)),
    peak: values.length === 0 ? null : Math.max(...values),
    highMinutes: highMinutes(today),
    distribution: distribution(today),
    trend: stressTrend(today, now),
    week: stressBaseline(usable, sleep, now, 7, 2),
    month: stressBaseline(usable, sleep, now, 30, 8),
    overnight: overnightAverage(usable, sleep),
  };
}

function distribution(today: MetricSample[]): StressDistribution {
  const counts = STRESS_BANDS.map((band) => today.filter((sample) => stressBand(sample.value) === band).length);
  const shares = largestRemainder(counts);
  return { Relaxed: shares[0], Low: shares[1], Moderate: shares[2], High: shares[3] };
}

function largestRemainder(counts: number[]): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((count) => (count / total) * 100);
  const floors = exact.map((value) => Math.floor(value));
  let leftover = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const item of order) {
    if (leftover <= 0) break;
    floors[item.index] += 1;
    leftover -= 1;
  }
  return floors;
}

function stressTrend(today: MetricSample[], now: Date): StressTrend | null {
  const cutoff = now.getTime() - STRESS_TREND_MS;
  const recent: number[] = [];
  const earlier: number[] = [];
  for (const sample of today) {
    const time = Date.parse(sample.timestamp);
    if (time >= cutoff) recent.push(sample.value);
    else earlier.push(sample.value);
  }
  if (recent.length < 2 || earlier.length < 2) return null;
  const gap = mean(recent) - mean(earlier);
  if (gap >= STRESS_TREND_GAP) return 'Rising';
  if (gap <= -STRESS_TREND_GAP) return 'Falling';
  return 'Steady';
}

function stressBaseline(
  samples: MetricSample[],
  sleep: SleepNight[],
  now: Date,
  windowDays: number,
  minimumDays: number,
): StressBaseline | null {
  const today = localDayNumber(now);
  if (today === null) return null;
  const picked: number[] = [];
  const days = new Set<number>();
  for (const sample of samples) {
    const day = localDayNumber(new Date(sample.timestamp));
    if (day === null) continue;
    const ago = (today - day) / DAY_MS;
    if (ago < 1 || ago > windowDays) continue;
    if (insideSleep(sleep, Date.parse(sample.timestamp))) continue;
    picked.push(sample.value);
    days.add(day);
  }
  if (days.size < minimumDays) return null;
  return { value: Math.round(mean(picked)), days: days.size };
}

function overnightAverage(samples: MetricSample[], sleep: SleepNight[]): number | null {
  const night = [...sleep]
    .filter((item) => Number.isFinite(Date.parse(item.startedAt)) && Number.isFinite(Date.parse(item.endedAt)))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0];
  if (!night) return null;
  const start = Date.parse(night.startedAt);
  const end = Date.parse(night.endedAt);
  const values = samples
    .filter((sample) => {
      const time = Date.parse(sample.timestamp);
      return time >= start && time < end;
    })
    .map((sample) => sample.value);
  if (values.length === 0) return null;
  return Math.round(mean(values));
}

function highMinutes(today: MetricSample[]): number {
  let total = 0;
  for (let index = 0; index < today.length; index += 1) {
    if (today[index].value < STRESS_HIGH) continue;
    if (index === today.length - 1) {
      total += STRESS_LAST_SLOT_MS;
      continue;
    }
    const gap = Date.parse(today[index + 1].timestamp) - Date.parse(today[index].timestamp);
    total += Math.min(Math.max(gap, 0), STRESS_HIGH_CAP_MS);
  }
  return Math.round(total / 60000);
}

function insideSleep(sleep: SleepNight[], time: number): boolean {
  return sleep.some((night) => {
    const start = Date.parse(night.startedAt);
    const end = Date.parse(night.endedAt);
    return Number.isFinite(start) && Number.isFinite(end) && time >= start && time < end;
  });
}

function localDayNumber(date: Date): number | null {
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
    stress: keepHistory ? unionByTimestamp(previous.stress ?? [], next.stress ?? []) : (next.stress ?? []),
    hrv: keepHistory ? unionByTimestamp(previous.hrv ?? [], next.hrv ?? []) : (next.hrv ?? []),
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
