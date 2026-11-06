export type AppSettings = {
  apiUrl: string;
  apiKey: string;
  ringId: string | null;
  ringName: string | null;
};

export type BatteryReading = {
  level: number;
  charging: boolean;
};

export type HeartRateSample = {
  timestamp: string;
  bpm: number;
};

export type StepSample = {
  timestamp: string;
  steps: number;
  calories: number;
  distanceMeters: number;
};

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
  spo2: number | null;
  bodyTemperatureC: number | null;
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
    spo2: next.spo2 ?? previous.spo2,
    bodyTemperatureC: next.bodyTemperatureC ?? previous.bodyTemperatureC,
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
};
