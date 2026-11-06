import { base64ToBytes } from './base64';
import { ringMatch } from './protocol';

export const SCAN_STALE_MS = 15_000;
export const SCAN_RESORT_MS = 4_000;

const NAMED_ENTER_RSSI = -85;
const UNNAMED_ENTER_RSSI = -65;
const OTHER_LIMIT = 24;

export type ScanSighting = {
  id: string;
  name: string | null;
  localName: string | null;
  rssi: number | null;
  serviceUUIDs: string[] | null;
  manufacturerData: string | null;
  rawScanRecord: string | null;
  isConnectable: boolean | null;
};

export type ListedDevice = {
  id: string;
  name: string;
  rawName: string | null;
  likely: boolean;
  match: string | null;
  rssi: number | null;
  rawRssi: number | null;
  ageSeconds: number;
  hits: number;
  serviceUUIDs: string[];
  manufacturerPreview: string | null;
  connectable: boolean | null;
};

type Entry = {
  id: string;
  rawName: string | null;
  likely: boolean;
  match: string | null;
  smoothed: number | null;
  rawRssi: number | null;
  lastSeenAt: number;
  hits: number;
  serviceUUIDs: string[];
  manufacturerPreview: string | null;
  connectable: boolean | null;
  onList: boolean;
};

const COLMI = [0x43, 0x4f, 0x4c, 0x4d, 0x49];

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\0/g, '').trim();
  return trimmed ? trimmed : null;
}

function usableRssi(value: number | null): number | null {
  if (value === null || Number.isNaN(value) || value > 0) return null;
  return value;
}

function smoothRssi(previous: number | null, sample: number | null): number | null {
  if (sample === null) return previous;
  if (previous === null) return sample;
  return Math.round(previous * 0.6 + sample * 0.4);
}

function preferName(current: string | null, incoming: string | null): string | null {
  if (!incoming) return current;
  if (!current) return incoming;
  const incomingRing = ringMatch(incoming, null);
  const currentRing = ringMatch(current, null);
  if (incomingRing && !currentRing) return incoming;
  if (currentRing && !incomingRing) return current;
  return incoming.length >= current.length ? incoming : current;
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  return clean(new TextDecoder().decode(bytes));
}

function nameFromManufacturer(encoded: string | null): string | null {
  if (!encoded) return null;
  const bytes = base64ToBytes(encoded);
  for (let start = 0; start <= bytes.length - COLMI.length; start += 1) {
    const found = COLMI.every((byte, offset) => bytes[start + offset] === byte);
    if (!found) continue;
    let end = start;
    while (end < bytes.length && end - start < 24) {
      const byte = bytes[end] ?? 0;
      if (byte < 32 || byte > 126) break;
      end += 1;
    }
    const name = decodeText(bytes.subarray(start, end));
    if (name) return name;
  }
  return null;
}

function readAdvertisedName(bytes: Uint8Array): string | null {
  let index = 0;
  let shortened: string | null = null;
  while (index < bytes.length) {
    const length = bytes[index] ?? 0;
    if (length === 0) break;
    const end = index + length + 1;
    if (end > bytes.length) break;
    const type = bytes[index + 1];
    const value = bytes.subarray(index + 2, end);
    if (type === 0x09 || type === 0x08) {
      const name = decodeText(value);
      if (type === 0x09 && name) return name;
      if (name) shortened = name;
    }
    index = end;
  }
  return shortened;
}

function nameFromRawRecord(encoded: string | null): string | null {
  if (!encoded) return null;
  const bytes = base64ToBytes(encoded);
  if (bytes.length === 0) return null;
  if (bytes[0] === 0x7b) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
        localName?: unknown;
        name?: unknown;
      };
      const localName = typeof parsed.localName === 'string' ? parsed.localName : null;
      const name = typeof parsed.name === 'string' ? parsed.name : null;
      return clean(localName) || clean(name);
    } catch {
      return null;
    }
  }
  return readAdvertisedName(bytes);
}

export function resolveAdvertisedName(sighting: {
  name: string | null;
  localName: string | null;
  manufacturerData: string | null;
  rawScanRecord: string | null;
}): string | null {
  const candidates = [
    clean(sighting.localName),
    clean(sighting.name),
    nameFromManufacturer(sighting.manufacturerData),
    nameFromRawRecord(sighting.rawScanRecord),
  ].filter((value): value is string => Boolean(value));
  const ringNames = candidates.filter((candidate) => ringMatch(candidate, null));
  if (ringNames.length > 0) {
    return ringNames.reduce((best, next) => (next.length > best.length ? next : best));
  }
  return candidates[0] ?? null;
}

function previewManufacturer(encoded: string | null): string | null {
  if (!encoded) return null;
  const bytes = base64ToBytes(encoded);
  if (bytes.length === 0) return null;
  return Array.from(bytes.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

function mergeServices(current: string[], incoming: string[] | null): string[] {
  if (!incoming) return current;
  const seen = new Set(current.map((uuid) => uuid.toLowerCase()));
  const next = [...current];
  for (const uuid of incoming) {
    const key = uuid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(uuid);
    if (next.length >= 8) break;
  }
  return next;
}

function displayName(entry: Entry): string {
  if (entry.rawName) return entry.rawName;
  return entry.likely ? 'Colmi ring' : 'Unnamed device';
}

function bySignal(left: Entry, right: Entry): number {
  return (right.smoothed ?? -200) - (left.smoothed ?? -200);
}

function blankEntry(id: string): Entry {
  return {
    id,
    rawName: null,
    likely: false,
    match: null,
    smoothed: null,
    rawRssi: null,
    lastSeenAt: 0,
    hits: 0,
    serviceUUIDs: [],
    manufacturerPreview: null,
    connectable: null,
    onList: false,
  };
}

export function createScanTracker() {
  const entries = new Map<string, Entry>();
  let order: string[] = [];
  let lastResort = -1;

  const refreshOrder = (now: number) => {
    const alive = [...entries.values()];
    const force = lastResort < 0 || now - lastResort >= SCAN_RESORT_MS;
    if (force) {
      const likely = alive.filter((entry) => entry.likely).sort(bySignal);
      const others = alive.filter((entry) => !entry.likely).sort(bySignal);
      order = [...likely, ...others].map((entry) => entry.id);
      lastResort = now;
      return;
    }

    const aliveIds = new Set(alive.map((entry) => entry.id));
    const kept = order.filter((id) => aliveIds.has(id));
    const keptIds = new Set(kept);
    const fresh = alive.filter((entry) => !keptIds.has(entry.id));
    const freshLikely = fresh.filter((entry) => entry.likely).sort(bySignal).map((entry) => entry.id);
    const freshOther = fresh.filter((entry) => !entry.likely).sort(bySignal).map((entry) => entry.id);
    const keptLikely = kept.filter((id) => entries.get(id)?.likely);
    const keptOther = kept.filter((id) => {
      const entry = entries.get(id);
      return entry ? !entry.likely : false;
    });
    const strongestOther = keptOther.reduce((best, id) => {
      const rssi = entries.get(id)?.smoothed ?? -200;
      return Math.max(best, rssi);
    }, -200);
    const promoted = freshOther.filter((id) => (entries.get(id)?.smoothed ?? -200) >= strongestOther + 8);
    const waiting = freshOther.filter((id) => !promoted.includes(id));
    order = [...freshLikely, ...keptLikely, ...promoted, ...keptOther, ...waiting];
  };

  return {
    observe(sighting: ScanSighting, now: number): { announce: string | null } {
      const previous = entries.get(sighting.id);
      const entry = previous ?? blankEntry(sighting.id);
      const wasLikely = entry.likely;
      const sample = usableRssi(sighting.rssi);
      const advertised = resolveAdvertisedName(sighting);

      entry.rawName = preferName(entry.rawName, advertised);
      entry.smoothed = smoothRssi(entry.smoothed, sample);
      if (sample !== null) entry.rawRssi = sample;
      entry.lastSeenAt = now;
      entry.hits += 1;
      entry.serviceUUIDs = mergeServices(entry.serviceUUIDs, sighting.serviceUUIDs);
      const manufacturer = previewManufacturer(sighting.manufacturerData);
      if (manufacturer) entry.manufacturerPreview = manufacturer;
      if (sighting.isConnectable !== null) entry.connectable = sighting.isConnectable;

      const match = ringMatch(entry.rawName, entry.serviceUUIDs);
      if (match) {
        entry.likely = true;
        entry.match = match;
      }

      if (!entry.onList) {
        const rssi = entry.smoothed ?? -200;
        if (entry.likely) entry.onList = true;
        else if (!entry.rawName) entry.onList = rssi >= UNNAMED_ENTER_RSSI;
        else entry.onList = rssi >= NAMED_ENTER_RSSI;
      }

      entries.set(sighting.id, entry);
      if (entry.likely && !wasLikely) {
        return { announce: `${displayName(entry)} · ${entry.smoothed ?? '—'} dBm · ${entry.id}` };
      }
      return { announce: null };
    },

    snapshot(now: number): ListedDevice[] {
      for (const [id, entry] of entries) {
        if (now - entry.lastSeenAt > SCAN_STALE_MS) entries.delete(id);
      }
      refreshOrder(now);

      const listed: ListedDevice[] = [];
      let others = 0;
      for (const id of order) {
        const entry = entries.get(id);
        if (!entry || !entry.onList) continue;
        if (!entry.likely) {
          if (others >= OTHER_LIMIT) continue;
          others += 1;
        }
        listed.push({
          id: entry.id,
          name: displayName(entry),
          rawName: entry.rawName,
          likely: entry.likely,
          match: entry.match,
          rssi: entry.smoothed,
          rawRssi: entry.rawRssi,
          ageSeconds: Math.max(0, Math.round((now - entry.lastSeenAt) / 1000)),
          hits: entry.hits,
          serviceUUIDs: entry.serviceUUIDs,
          manufacturerPreview: entry.manufacturerPreview,
          connectable: entry.connectable,
        });
      }
      return listed;
    },
  };
}
