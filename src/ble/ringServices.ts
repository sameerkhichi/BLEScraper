import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'blescraper.ringServices';

let services: string[] = [];
const listeners = new Set<() => void>();

function publish(): void {
  listeners.forEach((listener) => listener());
}

function normalize(found: string[]): string[] {
  return [...new Set(found.map((uuid) => uuid.toLowerCase()))].sort();
}

export function rememberRingServices(found: string[]): void {
  services = normalize(found);
  publish();
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(services)).catch(() => undefined);
}

export function clearRingServices(): void {
  services = [];
  publish();
  void AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
}

export async function hydrateRingServices(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    services = Array.isArray(parsed) ? normalize(parsed.filter((uuid): uuid is string => typeof uuid === 'string')) : [];
  } catch {
    services = [];
  }
  publish();
}

function getRingServices(): string[] {
  return services;
}

function subscribeRingServices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRingServices(): readonly string[] {
  return useSyncExternalStore(subscribeRingServices, getRingServices, getRingServices);
}
