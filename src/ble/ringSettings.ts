import { CMD_AUTO_HEART_RATE, CMD_AUTO_HRV, CMD_AUTO_SPO2, CMD_AUTO_STRESS, CMD_GESTURE } from './protocol';
import { makePacket } from './packet';

export const SETTING_READ = 0x01;
export const SETTING_WRITE = 0x02;
export const SETTING_ON = 0x01;
export const SETTING_OFF_ZERO = 0x00;
export const SETTING_OFF_TWO = 0x02;
export const CMD_PALM = 0x05;
export const HEART_RATE_INTERVALS = [5, 15, 30, 60] as const;

export type SettingField = 'heartRate' | 'spo2' | 'stress' | 'hrv' | 'gesture';

export type SettingPatch = {
  enabled: boolean;
  minutes?: number;
  offByte?: number;
};

export type ParsedSetting = {
  command: number;
  enabled: boolean;
  offByte: number;
  minutes: number | null;
  tail: number[];
  raw: number[];
};

export type FirmwareRead = {
  readAt: string | null;
  heartRate: ParsedSetting | null;
  spo2: ParsedSetting | null;
  stress: ParsedSetting | null;
  hrv: ParsedSetting | null;
  hrvAnswered: boolean;
  gesture: ParsedSetting | null;
  gestureCommand: number | null;
  warnings: string[];
};

export type PendingFirmware = {
  heartRate: boolean | null;
  heartRateMinutes: number | null;
  spo2: boolean | null;
  stress: boolean | null;
  hrv: boolean | null;
  gesture: boolean | null;
};

export function emptyFirmware(): FirmwareRead {
  return {
    readAt: null,
    heartRate: null,
    spo2: null,
    stress: null,
    hrv: null,
    hrvAnswered: false,
    gesture: null,
    gestureCommand: null,
    warnings: [],
  };
}

export function emptyPending(): PendingFirmware {
  return {
    heartRate: null,
    heartRateMinutes: null,
    spo2: null,
    stress: null,
    hrv: null,
    gesture: null,
  };
}

export function readSettingPacket(command: number): Uint8Array {
  return makePacket(command, [SETTING_READ]);
}

export function parseSetting(packet: Uint8Array, command: number): ParsedSetting | null {
  if (packet.length < 16 || packet[0] !== command) return null;
  if (command === CMD_GESTURE && packet[1] !== SETTING_READ) return null;
  if (packet[1] !== SETTING_READ && packet[1] !== SETTING_WRITE) return null;
  const flag = packet[2] ?? 0xff;
  if (flag !== SETTING_ON && flag !== SETTING_OFF_ZERO && flag !== SETTING_OFF_TWO) return null;
  const tail = Array.from(packet.slice(3, 15));
  return {
    command,
    enabled: flag === SETTING_ON,
    offByte: flag === SETTING_ON ? SETTING_OFF_TWO : flag,
    minutes: command === CMD_AUTO_HEART_RATE ? (packet[3] ?? 0) : null,
    tail,
    raw: Array.from(packet.slice(0, 16)),
  };
}

export function writeSettingPacket(command: number, previous: ParsedSetting | null, patch: SettingPatch): Uint8Array {
  const remembered = patch.offByte ?? previous?.offByte ?? SETTING_OFF_TWO;
  const offByte = remembered === SETTING_OFF_ZERO ? SETTING_OFF_ZERO : SETTING_OFF_TWO;
  const flag = patch.enabled ? SETTING_ON : offByte;
  const tail = previous ? [...previous.tail] : Array.from({ length: 12 }, () => 0);
  while (tail.length < 12) tail.push(0);
  if (command === CMD_AUTO_HEART_RATE && patch.minutes != null) {
    tail[0] = Math.min(255, Math.max(1, Math.round(patch.minutes))) & 0xff;
  }
  return makePacket(command, [SETTING_WRITE, flag, ...tail.slice(0, 12)]);
}

export function settingMatches(parsed: ParsedSetting, patch: SettingPatch): boolean {
  if (parsed.enabled !== patch.enabled) return false;
  if (patch.minutes != null && parsed.minutes !== Math.min(255, Math.max(1, Math.round(patch.minutes)))) return false;
  return true;
}

export function commandFor(field: Exclude<SettingField, 'gesture'>): number {
  switch (field) {
    case 'heartRate':
      return CMD_AUTO_HEART_RATE;
    case 'spo2':
      return CMD_AUTO_SPO2;
    case 'stress':
      return CMD_AUTO_STRESS;
    case 'hrv':
      return CMD_AUTO_HRV;
  }
}

export function describeFirmware(read: FirmwareRead): string {
  const heart = read.heartRate
    ? read.heartRate.enabled
      ? `Heart rate every ${read.heartRate.minutes} minutes`
      : 'Heart rate off'
    : 'Heart rate was not read';
  const spo2 = read.spo2 ? (read.spo2.enabled ? 'Blood oxygen on' : 'Blood oxygen off') : 'Blood oxygen was not read';
  const stress = read.stress ? (read.stress.enabled ? 'Stress on' : 'Stress off') : 'Stress was not read';
  const hrv = read.hrv ? (read.hrv.enabled ? 'HRV on' : 'HRV off') : 'HRV is not available on this ring';
  const gesture = read.gesture ? (read.gesture.enabled ? 'Gesture control on' : 'Gesture control off') : 'Gesture control was not read';
  const sentence = [heart, spo2, stress, hrv, gesture].join('. ');
  const warnings = read.warnings.filter((warning) => warning.length > 0);
  return warnings.length > 0 ? `${sentence}. ${warnings.join(' ')}` : `${sentence}.`;
}

function byteList(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value)) return null;
  const bytes = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)).slice(0, length);
  if (bytes.length === 0 && length > 0) return null;
  while (bytes.length < length) bytes.push(0);
  return bytes.map((item) => item & 0xff);
}

function parsedFrom(value: unknown, command: number): ParsedSetting | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<ParsedSetting>;
  if (typeof row.enabled !== 'boolean') return null;
  const tail = byteList(row.tail, 12);
  const raw = byteList(row.raw, 16);
  if (!tail || !raw) return null;
  const minutes = typeof row.minutes === 'number' && Number.isFinite(row.minutes) ? Math.round(row.minutes) : null;
  return {
    command: typeof row.command === 'number' ? row.command : command,
    enabled: row.enabled,
    offByte: row.offByte === SETTING_OFF_ZERO ? SETTING_OFF_ZERO : SETTING_OFF_TWO,
    minutes,
    tail,
    raw,
  };
}

export function firmwareFrom(value: unknown): FirmwareRead {
  if (!value || typeof value !== 'object') return emptyFirmware();
  const row = value as Partial<FirmwareRead>;
  const hrv = parsedFrom(row.hrv, CMD_AUTO_HRV);
  return {
    readAt: typeof row.readAt === 'string' ? row.readAt : null,
    heartRate: parsedFrom(row.heartRate, CMD_AUTO_HEART_RATE),
    spo2: parsedFrom(row.spo2, CMD_AUTO_SPO2),
    stress: parsedFrom(row.stress, CMD_AUTO_STRESS),
    hrv,
    hrvAnswered: row.hrvAnswered === true || hrv !== null,
    gesture: parsedFrom(row.gesture, typeof row.gestureCommand === 'number' ? row.gestureCommand : CMD_PALM),
    gestureCommand: typeof row.gestureCommand === 'number' ? row.gestureCommand : null,
    warnings: Array.isArray(row.warnings) ? row.warnings.filter((item): item is string => typeof item === 'string') : [],
  };
}

export function pendingFrom(value: unknown): PendingFirmware {
  if (!value || typeof value !== 'object') return emptyPending();
  const row = value as Partial<PendingFirmware>;
  const minutes =
    typeof row.heartRateMinutes === 'number' && row.heartRateMinutes >= 1 && row.heartRateMinutes <= 255
      ? Math.round(row.heartRateMinutes)
      : null;
  return {
    heartRate: typeof row.heartRate === 'boolean' ? row.heartRate : null,
    heartRateMinutes: minutes,
    spo2: typeof row.spo2 === 'boolean' ? row.spo2 : null,
    stress: typeof row.stress === 'boolean' ? row.stress : null,
    hrv: typeof row.hrv === 'boolean' ? row.hrv : null,
    gesture: typeof row.gesture === 'boolean' ? row.gesture : null,
  };
}

export function hasPendingFirmware(pending: PendingFirmware): boolean {
  return (
    pending.heartRate !== null ||
    pending.heartRateMinutes !== null ||
    pending.spo2 !== null ||
    pending.stress !== null ||
    pending.hrv !== null ||
    pending.gesture !== null
  );
}
