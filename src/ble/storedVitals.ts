import type { VitalSpot } from '../model';
import { bodyTemperatureCelsius, isPlausibleSpo2 } from './protocol';

const BIG_DATA_MAGIC = 0xbc;
export const STORED_SPO2 = 0x2a;
export const STORED_TEMPERATURE = 0x25;

const SLOTS_PER_DAY = 48;
const SLOT_MINUTES = 30;
const DAY_HEADER = 2;
const PAIR_DAY_BYTES = DAY_HEADER + SLOTS_PER_DAY * 2;

// Same 7-byte shape the ring already answers for sleep.
export function storedSeriesRequest(type: number): Uint8Array {
  return Uint8Array.of(BIG_DATA_MAGIC, type, 0x01, 0x00, 0xff, 0x00, 0xff);
}

export function parseStoredSpo2(packet: Uint8Array, now: Date): VitalSpot[] {
  const payload = seriesPayload(packet, STORED_SPO2, 'Blood oxygen packet was not a stored record.');
  if (payload.length >= PAIR_DAY_BYTES && payload.length % PAIR_DAY_BYTES === 0) {
    return parsePairDays(payload, now);
  }
  return parseSingleDays(payload, now, (raw) => {
    if (!isPlausibleSpo2(raw)) return null;
    return { spo2: raw, bodyTemperatureC: null };
  });
}

export function parseStoredTemperature(packet: Uint8Array, now: Date): VitalSpot[] {
  const payload = seriesPayload(packet, STORED_TEMPERATURE, 'Temperature packet was not a stored record.');
  return parseSingleDays(payload, now, (raw) => {
    const bodyTemperatureC = bodyTemperatureCelsius(raw);
    if (bodyTemperatureC === null) return null;
    return { spo2: null, bodyTemperatureC };
  });
}

function seriesPayload(packet: Uint8Array, type: number, mismatch: string): Uint8Array {
  if (packet.length < 6 || packet[0] !== BIG_DATA_MAGIC || packet[1] !== type) {
    throw new Error(mismatch);
  }
  const length = packet[2] | (packet[3] << 8);
  const end = Math.min(packet.length, 6 + length);
  return packet.subarray(6, end);
}

function parseSingleDays(
  payload: Uint8Array,
  now: Date,
  decode: (raw: number) => { spo2: number | null; bodyTemperatureC: number | null } | null,
): VitalSpot[] {
  const spots: VitalSpot[] = [];
  let offset = 0;
  while (offset + DAY_HEADER < payload.length) {
    const daysAgo = payload[offset] ?? 0;
    const midnight = utcMidnight(now) - daysAgo * 24 * 60 * 60 * 1000;
    const available = Math.min(SLOTS_PER_DAY, payload.length - offset - DAY_HEADER);
    for (let slot = 0; slot < available; slot += 1) {
      const reading = decode(payload[offset + DAY_HEADER + slot] ?? 0);
      if (!reading) continue;
      spots.push({
        timestamp: new Date(midnight + slot * SLOT_MINUTES * 60 * 1000).toISOString(),
        spo2: reading.spo2,
        bodyTemperatureC: reading.bodyTemperatureC,
      });
    }
    offset += DAY_HEADER + available;
    if (available < SLOTS_PER_DAY) break;
  }
  return spots;
}

function parsePairDays(payload: Uint8Array, now: Date): VitalSpot[] {
  const spots: VitalSpot[] = [];
  let offset = 0;
  while (offset + DAY_HEADER + 1 < payload.length) {
    const daysAgo = payload[offset] ?? 0;
    const midnight = utcMidnight(now) - daysAgo * 24 * 60 * 60 * 1000;
    const available = Math.min(SLOTS_PER_DAY, Math.floor((payload.length - offset - DAY_HEADER) / 2));
    if (available < 1) break;
    for (let slot = 0; slot < available; slot += 1) {
      const min = payload[offset + DAY_HEADER + slot * 2] ?? 0;
      const max = payload[offset + DAY_HEADER + slot * 2 + 1] ?? 0;
      const spo2 = isPlausibleSpo2(max) ? max : isPlausibleSpo2(min) ? min : null;
      if (spo2 === null) continue;
      spots.push({
        timestamp: new Date(midnight + slot * SLOT_MINUTES * 60 * 1000).toISOString(),
        spo2,
        bodyTemperatureC: null,
      });
    }
    offset += DAY_HEADER + available * 2;
    if (available < SLOTS_PER_DAY) break;
  }
  return spots;
}

function utcMidnight(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
