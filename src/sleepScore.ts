import type { SleepNight, SleepStage } from './model';

export type SleepScoreLabel = 'Excellent' | 'Good' | 'Fair' | 'Poor';

export type SleepScoreParts = {
  duration: number;
  efficiency: number;
  architecture: number;
  continuity: number;
  endedInDeepSleep: boolean;
};

export type SleepScore = {
  score: number;
  label: SleepScoreLabel;
  endedInDeepSleep: boolean;
};

export type ScoredSleepNight = SleepNight & {
  score: number;
  scoreLabel: SleepScoreLabel;
  endedInDeepSleep: boolean;
  sleepDebtMinutes: number;
};

const SLEEP_NEED_MINUTES = 8 * 60;

// 0h, 4h, 5h, 6h, 7–9h, then the long side mirrors the short side out to 13h.
const DURATION_KNOTS: Array<[number, number]> = [
  [0, 0],
  [4, 19],
  [5, 49],
  [6, 79],
  [7, 100],
  [9, 100],
  [10, 79],
  [11, 49],
  [12, 19],
  [13, 0],
];

export function durationScore(minutesAsleep: number): number {
  return betweenKnots(minutesAsleep / 60, DURATION_KNOTS);
}

export function efficiencyScore(minutesAsleep: number, minutesInBed: number): number {
  if (minutesInBed <= 0) return 0;
  const percent = (minutesAsleep / minutesInBed) * 100;
  if (percent >= 90) return 100;
  if (percent <= 60) return 0;
  return ((percent - 60) / 30) * 100;
}

export function architectureScore(night: Pick<SleepNight, 'minutesAsleep' | 'minutesDeep' | 'minutesRem' | 'minutesLight'>): number {
  if (night.minutesAsleep <= 0) return 0;
  const share = (minutes: number) => (minutes / night.minutesAsleep) * 100;
  const deep = bandScore(share(night.minutesDeep), 13, 23);
  const rem = bandScore(share(night.minutesRem), 20, 25);
  const light = bandScore(share(night.minutesLight), 50, 60);
  return deep * 0.45 + rem * 0.45 + light * 0.1;
}

export function continuityScore(minutesAwake: number, awakenings: number): number {
  const awake = falloff(minutesAwake, 20, 60);
  const wakes = falloff(awakenings, 1, 6);
  return (awake + wakes) / 2;
}

export function endedInDeepSleep(stages: SleepStage[]): boolean {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    const stage = stages[index];
    if (!stage || stage.stage === 'awake') continue;
    return stage.stage === 'deep';
  }
  return false;
}

export function sleepScoreParts(night: SleepNight): SleepScoreParts {
  return {
    duration: durationScore(night.minutesAsleep),
    efficiency: efficiencyScore(night.minutesAsleep, night.minutesInBed),
    architecture: architectureScore(night),
    continuity: continuityScore(night.minutesAwake, night.awakenings),
    endedInDeepSleep: endedInDeepSleep(night.stages),
  };
}

export function scoreSleepNight(night: SleepNight): SleepScore {
  const parts = sleepScoreParts(night);
  const weighted = (parts.duration * 0.3 + parts.efficiency * 0.25 + parts.architecture * 0.25 + parts.continuity * 0.15) / 0.95;
  const penalized = parts.endedInDeepSleep ? weighted - 5 : weighted;
  const score = clampScore(penalized);
  return { score, label: scoreLabel(score), endedInDeepSleep: parts.endedInDeepSleep };
}

export function annotateSleep(nights: SleepNight[]): ScoredSleepNight[] {
  const debt = new Map<SleepNight, number>();
  const ordered = [...nights].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  let balance = 0;
  for (const night of ordered) {
    balance = Math.min(0, balance + night.minutesAsleep - SLEEP_NEED_MINUTES);
    debt.set(night, balance < 0 ? -balance : 0);
  }
  return nights.map((night) => {
    const scored = scoreSleepNight(night);
    return {
      ...night,
      score: scored.score,
      scoreLabel: scored.label,
      endedInDeepSleep: scored.endedInDeepSleep,
      sleepDebtMinutes: debt.get(night) ?? 0,
    };
  });
}

export function debtForNight(nights: SleepNight[], night: SleepNight): number {
  const index = nights.indexOf(night);
  if (index < 0) return Math.max(0, SLEEP_NEED_MINUTES - night.minutesAsleep);
  return annotateSleep(nights)[index]?.sleepDebtMinutes ?? 0;
}

export function sleepDebtLabel(minutes: number): string {
  if (minutes <= 0) return 'No sleep debt';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `Debt ${rest}m`;
  if (rest === 0) return `Debt ${hours}h`;
  return `Debt ${hours}h ${rest}m`;
}

function bandScore(percent: number, low: number, high: number): number {
  if (percent >= low && percent <= high) return 100;
  const outside = percent < low ? low - percent : percent - high;
  return Math.max(0, 100 - outside * 5);
}

function falloff(value: number, fullUntil: number, zeroAt: number): number {
  if (value <= fullUntil) return 100;
  if (value >= zeroAt) return 0;
  return (100 * (zeroAt - value)) / (zeroAt - fullUntil);
}

function betweenKnots(hours: number, knots: Array<[number, number]>): number {
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (!first || !last) return 0;
  if (hours <= first[0]) return first[1];
  if (hours >= last[0]) return last[1];
  for (let index = 1; index < knots.length; index += 1) {
    const left = knots[index - 1];
    const right = knots[index];
    if (!left || !right || hours > right[0]) continue;
    const span = right[0] - left[0];
    if (span <= 0) return right[1];
    const t = (hours - left[0]) / span;
    return left[1] + t * (right[1] - left[1]);
  }
  return last[1];
}

function clampScore(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

function scoreLabel(score: number): SleepScoreLabel {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}
