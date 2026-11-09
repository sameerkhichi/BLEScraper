export const FEVER_C = 38;
export const MILD_HYPOTHERMIA_C = 35;
export const MODERATE_HYPOTHERMIA_C = 32;
export const SEVERE_HYPOTHERMIA_C = 28;
export const TEMP_ALERT_REMIND_HOURS = 4;
export const TEMP_ALERT_REMIND_MS = TEMP_ALERT_REMIND_HOURS * 60 * 60 * 1000;

export type TemperatureStage = 'normal' | 'fever' | 'mild' | 'moderate' | 'severe';
export type TemperatureTone = 'ok' | 'warn' | 'danger';
export type AbnormalStage = Exclude<TemperatureStage, 'normal'>;

export type TemperatureNotice = {
  stage: AbnormalStage;
  celsius: number;
  notifiedAt: string;
};

// Finger reading. Fever starts at 38°C (100.4°F). Cold alerts start below
// 35°C (95°F), then 32°C (89.6°F), then 28°C (82.4°F).
export function temperatureStage(celsius: number): TemperatureStage {
  if (celsius >= FEVER_C) return 'fever';
  if (celsius >= MILD_HYPOTHERMIA_C) return 'normal';
  if (celsius >= MODERATE_HYPOTHERMIA_C) return 'mild';
  if (celsius >= SEVERE_HYPOTHERMIA_C) return 'moderate';
  return 'severe';
}

export function temperatureZone(celsius: number): { label: string; tone: TemperatureTone } {
  switch (temperatureStage(celsius)) {
    case 'fever':
      return { label: 'Fever', tone: 'danger' };
    case 'mild':
      return { label: 'Mild hypothermia', tone: 'warn' };
    case 'moderate':
      return { label: 'Moderate hypothermia', tone: 'danger' };
    case 'severe':
      return { label: 'Severe hypothermia', tone: 'danger' };
    default:
      return { label: 'Normal', tone: 'ok' };
  }
}

export function fahrenheit(celsius: number): number {
  return Math.round(((celsius * 9) / 5 + 32) * 10) / 10;
}

export function temperatureAlertCopy(celsius: number): { title: string; body: string } {
  const reading = `${celsius.toFixed(1)}°C (${fahrenheit(celsius).toFixed(1)}°F)`;
  switch (temperatureStage(celsius)) {
    case 'fever':
      return { title: 'Body temperature is high', body: `${reading}. Fever range.` };
    case 'mild':
      return { title: 'Body temperature is low', body: `${reading}. Mild hypothermia.` };
    case 'moderate':
      return { title: 'Body temperature is very low', body: `${reading}. Moderate hypothermia.` };
    case 'severe':
      return { title: 'Body temperature is dangerously low', body: `${reading}. Severe hypothermia.` };
    default:
      return { title: 'Body temperature', body: reading };
  }
}

// An out-of-range reading notifies once. A worse stage notifies immediately.
// The same stage waits out the reminder. A normal reading clears the notice.
export function nextTemperatureNotice(
  celsius: number | null,
  previous: TemperatureNotice | null,
  now: number,
): { notify: boolean; next: TemperatureNotice | null } {
  if (!knownCelsius(celsius)) return { notify: false, next: previous };

  const stage = temperatureStage(celsius);
  if (stage === 'normal') return { notify: false, next: null };

  const current: TemperatureNotice = {
    stage,
    celsius,
    notifiedAt: new Date(now).toISOString(),
  };
  if (!previous) return { notify: true, next: current };

  const notifiedAt = Date.parse(previous.notifiedAt);
  const due = !Number.isFinite(notifiedAt) || now - notifiedAt >= TEMP_ALERT_REMIND_MS;
  if (due || crossedWorsePoint(previous.stage, stage)) return { notify: true, next: current };

  if (previous.stage === stage && previous.celsius === celsius) return { notify: false, next: previous };
  return {
    notify: false,
    next: { stage, celsius, notifiedAt: previous.notifiedAt },
  };
}

function knownCelsius(celsius: number | null): celsius is number {
  return typeof celsius === 'number' && Number.isFinite(celsius);
}

function crossedWorsePoint(previous: AbnormalStage, next: AbnormalStage): boolean {
  if (side(previous) !== side(next)) return true;
  return rank(next) > rank(previous);
}

function side(stage: AbnormalStage): 'high' | 'low' {
  return stage === 'fever' ? 'high' : 'low';
}

function rank(stage: AbnormalStage): number {
  if (stage === 'fever') return 1;
  if (stage === 'mild') return 1;
  if (stage === 'moderate') return 2;
  return 3;
}
