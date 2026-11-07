import AsyncStorage from '@react-native-async-storage/async-storage';

import { defaultSettings, isAccelSample, isSleepNight, type AppSettings, type UploadPayload } from '../model';
import type { PendingUpload } from './queue';
import { emptyAutoSyncState, type AutoSyncState } from './schedule';

const SETTINGS_KEY = 'blescraper.settings';
const QUEUE_KEY = 'blescraper.queue';
const LAST_KEY = 'blescraper.lastPayload';
const AUTO_SYNC_KEY = 'blescraper.autoSync';

export async function loadSettings(): Promise<AppSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return defaultSettings;
  const parsed = JSON.parse(raw) as Partial<AppSettings>;
  return {
    apiUrl: typeof parsed.apiUrl === 'string' ? parsed.apiUrl : '',
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    ringId: typeof parsed.ringId === 'string' ? parsed.ringId : null,
    ringName: typeof parsed.ringName === 'string' ? parsed.ringName : null,
    autoSync: typeof parsed.autoSync === 'boolean' ? parsed.autoSync : true,
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function loadQueue(): Promise<PendingUpload[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as PendingUpload[];
  return Array.isArray(parsed) ? parsed : [];
}

export async function saveQueue(queue: PendingUpload[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function loadLastPayload(): Promise<UploadPayload | null> {
  const raw = await AsyncStorage.getItem(LAST_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as UploadPayload;
  return {
    ...parsed,
    spo2: typeof parsed.spo2 === 'number' ? parsed.spo2 : null,
    bodyTemperatureC: typeof parsed.bodyTemperatureC === 'number' ? parsed.bodyTemperatureC : null,
    accelerometer: isAccelSample(parsed.accelerometer) ? parsed.accelerometer : null,
    sleep: Array.isArray(parsed.sleep) ? parsed.sleep.filter(isSleepNight) : [],
  };
}

export async function saveLastPayload(payload: UploadPayload): Promise<void> {
  await AsyncStorage.setItem(LAST_KEY, JSON.stringify(payload));
}

export async function loadAutoSyncState(): Promise<AutoSyncState> {
  const raw = await AsyncStorage.getItem(AUTO_SYNC_KEY);
  if (!raw) return emptyAutoSyncState;
  const parsed = JSON.parse(raw) as Partial<AutoSyncState>;
  return {
    logsAt: timeOrNull(parsed.logsAt),
    vitalsAt: timeOrNull(parsed.vitalsAt),
    sleepAt: timeOrNull(parsed.sleepAt),
    failedAt: timeOrNull(parsed.failedAt),
  };
}

export async function saveAutoSyncState(state: AutoSyncState): Promise<void> {
  await AsyncStorage.setItem(AUTO_SYNC_KEY, JSON.stringify(state));
}

function timeOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}
