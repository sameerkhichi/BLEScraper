const MAX_LINES = 40;

let lines: string[] = [];
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
  listeners.forEach((listener) => listener());
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(`[ble] ${message}`);
  }
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
