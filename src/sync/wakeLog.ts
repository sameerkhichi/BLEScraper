import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'blescraper.lastBackgroundWake';

export type BackgroundWake = {
  startedAt: string;
  note: string;
};

let wake: BackgroundWake | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  listeners.forEach((listener) => listener());
}

export async function recordBackgroundWake(startedAt: Date, note: string): Promise<void> {
  wake = { startedAt: startedAt.toISOString(), note };
  publish();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(wake));
}

export async function hydrateBackgroundWake(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<BackgroundWake>) : null;
    wake =
      parsed && typeof parsed.startedAt === 'string' && typeof parsed.note === 'string'
        ? { startedAt: parsed.startedAt, note: parsed.note }
        : null;
  } catch {
    wake = null;
  }
  publish();
}

function getBackgroundWake(): BackgroundWake | null {
  return wake;
}

function subscribeBackgroundWake(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBackgroundWake(): BackgroundWake | null {
  return useSyncExternalStore(subscribeBackgroundWake, getBackgroundWake, getBackgroundWake);
}
