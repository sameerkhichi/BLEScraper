import type { BatteryReading } from '../model';

export const LOW_BATTERY_PERCENT = 15;
export const LOW_BATTERY_REMIND_HOURS = 4;
export const LOW_BATTERY_REMIND_MS = LOW_BATTERY_REMIND_HOURS * 60 * 60 * 1000;

export type BatteryNotice = {
  level: number;
  notifiedAt: string;
};

export function batteryAlertCopy(battery: BatteryReading): { title: string; body: string } {
  return {
    title: 'Ring battery is low',
    body: battery.charging
      ? `The ring is at ${battery.level}% and charging.`
      : `The ring is at ${battery.level}%. Charge it soon.`,
  };
}

// A reading under the threshold notifies once, then again when the level falls
// or the reminder interval passes. A healthier reading clears that memory.
export function nextBatteryNotice(
  battery: BatteryReading | null,
  previous: BatteryNotice | null,
  now: number,
): { notify: boolean; next: BatteryNotice | null } {
  const level = knownLevel(battery);
  if (level === null) return { notify: false, next: previous };
  if (level >= LOW_BATTERY_PERCENT) return { notify: false, next: null };

  const notifiedAt = previous ? Date.parse(previous.notifiedAt) : Number.NaN;
  const due = !previous || !Number.isFinite(notifiedAt) || now - notifiedAt >= LOW_BATTERY_REMIND_MS;
  const dropped = previous !== null && level < previous.level;
  if (!due && !dropped) return { notify: false, next: previous };

  return {
    notify: true,
    next: { level, notifiedAt: new Date(now).toISOString() },
  };
}

function knownLevel(battery: BatteryReading | null): number | null {
  if (!battery || !Number.isInteger(battery.level)) return null;
  if (battery.level < 0 || battery.level > 100) return null;
  return battery.level;
}
