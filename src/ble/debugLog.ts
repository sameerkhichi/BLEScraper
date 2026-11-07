import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'blescraper.debugLog';
const MAX_LINES = 200;

let lines: string[] = [];
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function stamp(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function debugLog(message: string): void {
  lines = [`${stamp()}  ${message}`, ...lines].slice(0, MAX_LINES);
  publish();
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(`[ble] ${message}`);
  }
}

export async function hydrateDebugLog(): Promise<void> {
  if (hydrated) return;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as unknown) : [];
    const previous = Array.isArray(stored) ? stored.filter((line): line is string => typeof line === 'string') : [];
    if (previous.length > 0) {
      const seen = new Set(lines);
      lines = [...lines, ...previous.filter((line) => !seen.has(line))].slice(0, MAX_LINES);
    }
  } catch {
    // Keep whatever this session already recorded.
  }
  hydrated = true;
  publish();
}

export async function flushDebugLog(): Promise<void> {
  if (!hydrated) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  } catch {
    // The on-screen log still has the lines.
  }
}

function publish(): void {
  listeners.forEach((listener) => listener());
  if (!hydrated) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(lines)).catch(() => undefined);
  }, 400);
}

export function getDebugLines(): readonly string[] {
  return lines;
}

export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
