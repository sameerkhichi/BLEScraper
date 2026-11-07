import type { AccelReading, BatteryReading, HeartRateSample, StepSample } from '../model';
import { bcdToDecimal, byteToBcd, makePacket, readInt32LE, writeInt32LE } from './packet';

export const UART_SERVICE_UUID = '6E40FFF0-B5A3-F393-E0A9-E50E24DCCA9E';
export const UART_RX_UUID = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E';
export const UART_TX_UUID = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';

export const CMD_SET_TIME = 1;
export const CMD_BATTERY = 3;
export const CMD_READ_HEART_RATE = 21;
export const CMD_STEPS = 67;
export const CMD_START_REAL_TIME = 105;
export const CMD_STOP_REAL_TIME = 106;
export const CMD_RAW_SENSOR = 0xa1;
export const RAW_SENSOR_ENABLE = 0x04;
// R09 and R12 turn the sensor lights off with 0x05. The older 0x02 stop leaves them flashing.
export const RAW_SENSOR_DISABLE = 0x05;
export const REALTIME_HEART_RATE = 1;
export const REALTIME_SPO2 = 3;
export const REALTIME_HEART_RATE_STREAM = 6;
export const REALTIME_TEMPERATURE = 0x0b;

const ACTION_START = 1;

export type NoData = { kind: 'none' };

export type HeartRateLog = {
  kind: 'log';
  timestamp: string;
  rangeMinutes: number;
  samples: HeartRateSample[];
};

export function setTimePacket(target: Date): Uint8Array {
  return makePacket(CMD_SET_TIME, [
    byteToBcd(target.getUTCFullYear() % 100),
    byteToBcd(target.getUTCMonth() + 1),
    byteToBcd(target.getUTCDate()),
    byteToBcd(target.getUTCHours()),
    byteToBcd(target.getUTCMinutes()),
    byteToBcd(target.getUTCSeconds()),
    1,
  ]);
}

export function batteryPacket(): Uint8Array {
  return makePacket(CMD_BATTERY);
}

export function parseBattery(packet: Uint8Array): BatteryReading {
  return {
    level: packet[1],
    charging: packet[2] !== 0,
  };
}

export function readHeartRatePacket(day: Date): Uint8Array {
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return makePacket(CMD_READ_HEART_RATE, writeInt32LE(Math.floor(midnight / 1000)));
}

export function readStepsPacket(dayOffset: number): Uint8Array {
  return makePacket(CMD_STEPS, [dayOffset & 0xff, 0x0f, 0x00, 0x5f, 0x01]);
}

export function startRealtimePacket(readingType: number): Uint8Array {
  return makePacket(CMD_START_REAL_TIME, [readingType, ACTION_START]);
}

// QRing's manual heart-rate command is type 1 with a zero second byte.
// Action 1 only produces an empty acknowledgement on this ring.
export function startHeartRatePacket(): Uint8Array {
  return makePacket(CMD_START_REAL_TIME, [REALTIME_HEART_RATE, 0]);
}

export function stopRealtimePacket(readingType: number): Uint8Array {
  return makePacket(CMD_STOP_REAL_TIME, [readingType, 0, 0]);
}

export function parseRealtime(packet: Uint8Array):
  | { kind: 'reading'; reading: number; value: number }
  | { kind: 'error'; reading: number; code: number } {
  if (packet[2] !== 0) {
    return { kind: 'error', reading: packet[1], code: packet[2] };
  }
  return { kind: 'reading', reading: packet[1], value: packet[3] };
}

// Heart-rate replies on this ring are not shaped like SpO2. A settled BPM may sit in byte 3
// with a non-zero status in byte 2, or in byte 2 on its own.
export function parseLiveHeartRate(packet: Uint8Array): number | null {
  if (packet[0] !== CMD_START_REAL_TIME) return null;
  if (packet[1] !== REALTIME_HEART_RATE && packet[1] !== REALTIME_HEART_RATE_STREAM) return null;

  const statusOrBpm = packet[2] ?? 0;
  const value = packet[3] ?? 0;
  if (isPlausibleHeartRate(value)) return value;
  if (isPlausibleHeartRate(statusOrBpm)) return statusOrBpm;
  return null;
}

export function isPlausibleHeartRate(value: number): boolean {
  return value >= 30 && value <= 220;
}

// Live heart-rate packets use byte 2 as a status. 1 with no BPM means the ring
// is off the finger and has aborted. 2 means this sample is missing but the
// measurement is still running. 3 or higher aborts for another reason.
export function classifyWear(packet: Uint8Array): 'worn' | 'off' | 'pending' {
  if (packet[0] !== CMD_START_REAL_TIME) return 'pending';
  if (packet[1] !== REALTIME_HEART_RATE && packet[1] !== REALTIME_HEART_RATE_STREAM) return 'pending';
  if (parseLiveHeartRate(packet) !== null) return 'worn';
  const status = packet[2] ?? 0;
  if (status === 1 || status >= 3) return 'off';
  return 'pending';
}

export function isPlausibleSpo2(value: number): boolean {
  return value >= 70 && value <= 100;
}

// Stored as tenths above a 20°C offset: 154 -> 35.4°C. Values under 11 are still warming up.
export function bodyTemperatureCelsius(raw: number): number | null {
  if (raw < 11) return null;
  const celsius = Math.round((raw / 10 + 20) * 10) / 10;
  if (celsius < 28 || celsius > 43) return null;
  return celsius;
}

export function rawSensorPacket(action: number): Uint8Array {
  return makePacket(CMD_RAW_SENSOR, [action]);
}

export type RawSensorFrame =
  | { kind: 'accelerometer'; reading: AccelReading }
  | { kind: 'ppg'; value: number; max: number; min: number; diff: number }
  | { kind: 'optical'; value: number };

export function parseRawSensor(packet: Uint8Array): RawSensorFrame | null {
  if (packet[0] !== CMD_RAW_SENSOR) return null;
  if (packet[1] === 3) {
    return {
      kind: 'accelerometer',
      reading: {
        x: signed12((packet[6] << 4) | (packet[7] & 0x0f)) / 512,
        y: signed12((packet[2] << 4) | (packet[3] & 0x0f)) / 512,
        z: signed12((packet[4] << 4) | (packet[5] & 0x0f)) / 512,
      },
    };
  }
  if (packet[1] === 2) {
    return {
      kind: 'ppg',
      value: (packet[2] << 8) | packet[3],
      max: (packet[4] << 8) | packet[5],
      min: (packet[6] << 8) | packet[7],
      diff: (packet[8] << 8) | packet[9],
    };
  }
  if (packet[1] === 1) {
    return { kind: 'optical', value: (packet[2] << 8) | packet[3] };
  }
  return null;
}

function signed12(value: number): number {
  const raw = value & 0xfff;
  return raw >= 0x800 ? raw - 0x1000 : raw;
}

// Degrees each axis is raised from level. Positive X is the fingertip end up.
// Positive Y is the right side of that view up. Turning the ring over does not swap the sign.
export function ringTilt(reading: AccelReading): { alongDeg: number; acrossDeg: number } {
  const along = (Math.atan2(reading.x, Math.hypot(reading.y, reading.z)) * 180) / Math.PI;
  const across = (Math.atan2(reading.y, Math.hypot(reading.x, reading.z)) * 180) / Math.PI;
  return { alongDeg: Math.round(along), acrossDeg: Math.round(across) };
}

export class HeartRateLogParser {
  private raw: number[] = [];
  private timestampMs: number | null = null;
  private size = 0;
  private index = 0;
  private range = 5;

  reset(): void {
    this.raw = [];
    this.timestampMs = null;
    this.size = 0;
    this.index = 0;
    this.range = 5;
  }

  parse(packet: Uint8Array): HeartRateLog | NoData | null {
    const subType = packet[1];
    if (subType === 255) {
      this.reset();
      return { kind: 'none' };
    }

    if (this.isToday() && subType === 23) {
      const result = this.toLog();
      this.reset();
      return result;
    }

    if (subType === 0) {
      this.size = packet[2];
      this.range = packet[3] || 5;
      this.raw = Array(this.size * 13).fill(-1);
      this.index = 0;
      this.timestampMs = null;
      return null;
    }

    if (subType === 1) {
      this.timestampMs = readInt32LE(packet, 2) * 1000;
      for (let offset = 0; offset < 9; offset += 1) {
        this.raw[offset] = packet[6 + offset];
      }
      this.index += 9;
      return null;
    }

    for (let offset = 0; offset < 13; offset += 1) {
      this.raw[this.index + offset] = packet[2 + offset];
    }
    this.index += 13;

    if (subType === this.size - 1) {
      const result = this.toLog();
      this.reset();
      return result;
    }

    return null;
  }

  private isToday(): boolean {
    if (this.timestampMs === null) return false;
    const stamp = new Date(this.timestampMs);
    const now = new Date();
    return (
      stamp.getUTCFullYear() === now.getUTCFullYear() &&
      stamp.getUTCMonth() === now.getUTCMonth() &&
      stamp.getUTCDate() === now.getUTCDate()
    );
  }

  private toLog(): HeartRateLog {
    if (this.timestampMs === null) {
      throw new Error('Heart-rate log did not include a timestamp.');
    }

    let values = this.raw.slice();
    if (values.length > 288) values = values.slice(0, 288);
    if (values.length < 288) values = values.concat(Array(288 - values.length).fill(0));

    if (this.isToday()) {
      const now = new Date();
      const slot = Math.floor((now.getUTCHours() * 60 + now.getUTCMinutes()) / 5);
      for (let index = slot; index < values.length; index += 1) values[index] = 0;
    }

    const start = this.timestampMs;
    const samples: HeartRateSample[] = [];
    values.forEach((value, index) => {
      const bpm = value < 0 ? 0 : value;
      if (bpm <= 0 || bpm >= 255) return;
      samples.push({
        timestamp: new Date(start + index * 5 * 60 * 1000).toISOString(),
        bpm,
      });
    });

    return {
      kind: 'log',
      timestamp: new Date(start).toISOString(),
      rangeMinutes: this.range,
      samples,
    };
  }
}

export class SportDetailParser {
  private newCalorieProtocol = false;
  private index = 0;
  private details: StepSample[] = [];

  reset(): void {
    this.newCalorieProtocol = false;
    this.index = 0;
    this.details = [];
  }

  parse(packet: Uint8Array): StepSample[] | NoData | null {
    if (this.index === 0 && packet[1] === 255) {
      this.reset();
      return { kind: 'none' };
    }

    if (this.index === 0 && packet[1] === 240) {
      this.newCalorieProtocol = packet[3] === 1;
      this.index += 1;
      return null;
    }

    const year = bcdToDecimal(packet[1]) + 2000;
    const month = bcdToDecimal(packet[2]);
    const day = bcdToDecimal(packet[3]);
    const timeIndex = packet[4];
    let calories = packet[7] | (packet[8] << 8);
    if (this.newCalorieProtocol) calories *= 10;
    const steps = packet[9] | (packet[10] << 8);
    const distanceMeters = packet[11] | (packet[12] << 8);
    const hour = Math.floor(timeIndex / 4);
    const minute = (timeIndex % 4) * 15;

    this.details.push({
      timestamp: new Date(Date.UTC(year, month - 1, day, hour, minute, 0)).toISOString(),
      steps,
      calories,
      distanceMeters,
    });

    if (packet[5] === packet[6] - 1) {
      const finished = this.details;
      this.reset();
      return finished;
    }

    this.index += 1;
    return null;
  }
}

export function isLikelyRing(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  return /colmi|qring|smart\s*ring|(?:^|[_\s-])(?:r0\d|ca\d{2})(?:$|[_\s-])/i.test(trimmed);
}

export function ringMatch(name: string | null, serviceUuids: string[] | null | undefined): string | null {
  if (isLikelyRing(name)) return `Name ${name}`;
  if (advertisesColmiService(serviceUuids)) return 'Advertises the Colmi service';
  return null;
}

function normalizeUuid(value: string): string {
  return value.replace(/-/g, '').toLowerCase();
}

export function advertisesColmiService(serviceUuids: string[] | null | undefined): boolean {
  const colmi = normalizeUuid(UART_SERVICE_UUID);
  return (serviceUuids ?? []).some((uuid) => normalizeUuid(uuid) === colmi);
}
