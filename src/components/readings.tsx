import { StyleSheet, Text, View } from 'react-native';

import type { HeartRateSample, SleepNight, SleepStageName, StepSample } from '../model';
import { colors } from './ui';

const COLD = '#6ea8ff';
const WARN = '#f0c36a';
const TEMP_MIN = 35;
const TEMP_MAX = 40;
const SPARK_POINTS = 36;

const stageColor: Record<SleepStageName, string> = {
  light: '#7fbf8a',
  deep: '#6ea8ff',
  rem: WARN,
  awake: colors.danger,
  unknown: colors.muted,
};

const stageHeight: Record<SleepStageName, number> = {
  awake: 16,
  rem: 30,
  unknown: 22,
  light: 44,
  deep: 58,
};

export const stageLabel: Record<SleepStageName, string> = {
  light: 'Light',
  deep: 'Deep',
  rem: 'REM',
  awake: 'Awake',
  unknown: 'Unknown',
};

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

export function formatClock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function latestNight(nights: SleepNight[]): SleepNight | null {
  if (nights.length === 0) return null;
  return nights.reduce((latest, night) => (night.daysAgo < latest.daysAgo ? night : latest));
}

// The ring does not report quality. This estimate favors about 8 hours asleep,
// a larger share of deep and REM, and fewer awakenings.
export function sleepQuality(night: SleepNight): { score: number; label: string } {
  const asleepHours = night.minutesAsleep / 60;
  const durationScore = Math.max(0, 100 - Math.abs(asleepHours - 8) * 15);
  const restorative =
    night.minutesAsleep === 0 ? 0 : ((night.minutesDeep + night.minutesRem) / night.minutesAsleep) * 100;
  const awakePenalty = Math.min(40, night.awakenings * 8 + night.minutesAwake / 3);
  const score = Math.round(Math.max(0, Math.min(100, durationScore * 0.5 + restorative * 0.5 - awakePenalty)));
  const label = score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
  return { score, label };
}

export function ActivityChart({ steps }: { steps: StepSample[] }) {
  let stepTotal = 0;
  let calories = 0;
  for (const sample of steps) {
    if (!isSameUtcDay(sample.timestamp)) continue;
    stepTotal += sample.steps;
    calories += sample.calories;
  }

  return (
    <View style={styles.block}>
      <Text style={styles.label}>Today</Text>
      <View style={styles.activityRow}>
        <View style={styles.activityStat}>
          <View style={styles.activityCircle}>
            <Text adjustsFontSizeToFit numberOfLines={1} style={styles.activityValue}>
              {formatCount(stepTotal)}
            </Text>
          </View>
          <ShoeOutline />
          <Text style={styles.meta}>Steps</Text>
        </View>
        <View style={styles.activityStat}>
          <View style={styles.activityCircle}>
            <Text adjustsFontSizeToFit numberOfLines={1} style={styles.activityValue}>
              {formatCount(calories)}
            </Text>
          </View>
          <FlameOutline />
          <Text style={styles.meta}>Calories</Text>
        </View>
      </View>
    </View>
  );
}

function ShoeOutline() {
  return (
    <View accessibilityLabel="Shoe" style={styles.shoe}>
      <View style={styles.shoeHeel} />
      <View style={styles.shoeUpper} />
      <View style={styles.shoeToe} />
      <View style={styles.shoeLace} />
      <View style={styles.shoeSole} />
    </View>
  );
}

function FlameOutline() {
  return (
    <View accessibilityLabel="Flame" style={styles.flame}>
      <View style={styles.flameOuter} />
      <View style={styles.flameInner} />
    </View>
  );
}

export function HeartRateChart({ bpm, samples }: { bpm: number | null; samples: HeartRateSample[] }) {
  const values = seriesForChart(samples);
  const caption = heartCaption(samples);
  return (
    <View style={styles.heartRow}>
      <View>
        <Text style={styles.vitalValue}>{bpm == null ? '—' : `${bpm}`}</Text>
        <Text style={styles.meta}>bpm</Text>
      </View>
      <View style={styles.sparkWrap}>
        {values.length === 0 ? (
          <Text style={styles.meta}>No stored heart rate yet.</Text>
        ) : (
          <>
            <View style={styles.spark}>
              {values.map((value, index) => (
                <View key={`${index}-${value}`} style={[styles.sparkBar, { height: sparkHeight(value) }]} />
              ))}
            </View>
            <View style={styles.sparkBaseline} />
            {caption ? <Text style={styles.caption}>{caption}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

export function OxygenMeter({ spo2 }: { spo2: number | null }) {
  const band = spo2 == null ? null : oxygenBand(spo2);
  return (
    <View style={styles.block}>
      <Text style={styles.vitalValue}>{spo2 == null ? '—' : `${spo2}%`}</Text>
      <Text style={[styles.meta, band ? { color: band.color } : null]}>
        {band?.label ?? 'Measure to fill this in.'}
      </Text>
      <View style={styles.meter}>
        <View style={styles.track}>
          <View style={[styles.segment, { backgroundColor: 'rgba(255,139,120,0.9)' }]} />
          <View style={[styles.segment, { backgroundColor: 'rgba(240,195,106,0.95)' }]} />
          <View style={[styles.segment, { backgroundColor: 'rgba(155,231,176,0.95)' }]} />
        </View>
        {spo2 == null ? null : <View style={[styles.needle, { left: `${markerPercent(spo2)}%` }]} />}
      </View>
      <View style={styles.scaleRow}>
        <Text style={styles.scaleLabel}>85</Text>
        <Text style={styles.scaleLabel}>90</Text>
        <Text style={styles.scaleLabel}>95</Text>
        <Text style={styles.scaleLabel}>100</Text>
      </View>
    </View>
  );
}

export function Thermometer({ celsius }: { celsius: number | null }) {
  const zone = celsius == null ? null : tempZone(celsius);
  const mercuryColor = zone == null ? colors.line : zone.color;
  return (
    <View style={styles.thermoRow}>
      <View style={styles.ticks}>
        <Text style={[styles.tick, styles.tickTop]}>40°</Text>
        <Text style={[styles.tick, styles.tickHot]}>37.5°</Text>
        <Text style={[styles.tick, styles.tickComfort]}>36°</Text>
        <Text style={[styles.tick, styles.tickBottom]}>35°</Text>
      </View>
      <View style={styles.thermoColumn}>
        <View style={styles.tube}>
          <View style={[styles.zone, styles.hotZone]} />
          <View style={[styles.zone, styles.comfortZone]} />
          <View style={[styles.zone, styles.coldZone]} />
          <View style={styles.stem} />
          {celsius == null ? null : (
            <View
              style={[
                styles.mercury,
                { backgroundColor: mercuryColor, height: `${temperatureFraction(celsius) * 100}%` },
              ]}
            />
          )}
        </View>
        <View style={[styles.bulb, { backgroundColor: celsius == null ? colors.line : mercuryColor }]} />
      </View>
      <View style={styles.thermoReading}>
        <Text style={styles.vitalValue}>{celsius == null ? '—' : `${celsius.toFixed(1)}°`}</Text>
        <Text style={[styles.meta, zone ? { color: zone.color } : null]}>
          {zone?.label ?? 'Measure to fill this in.'}
        </Text>
      </View>
    </View>
  );
}

export function SleepNightSummary({ night }: { night: SleepNight }) {
  const quality = sleepQuality(night);
  const legend: SleepStageName[] = ['deep', 'light', 'rem', 'awake'];
  if (night.minutesUnknown > 0) legend.push('unknown');

  return (
    <View style={styles.block}>
      <Text style={styles.nightDate}>{nightDateLabel(night)}</Text>
      <Text style={styles.nightRange}>
        {formatClock(night.startedAt)} – {formatClock(night.endedAt)}
      </Text>
      <View style={styles.summaryRow}>
        <View style={styles.summaryStat}>
          <Text style={styles.summaryValue}>{formatDuration(night.minutesAsleep)}</Text>
          <Text style={styles.meta}>Asleep</Text>
        </View>
        <View style={styles.summaryStat}>
          <Text style={[styles.summaryValue, { color: qualityColor(quality.label) }]}>{quality.score}</Text>
          <Text style={styles.meta}>{`${quality.label} · estimated`}</Text>
        </View>
      </View>
      <View style={styles.stageRow}>
        <StageTime label="Deep" minutes={night.minutesDeep} />
        <StageTime label="Light" minutes={night.minutesLight} />
        <StageTime label="REM" minutes={night.minutesRem} />
        <StageTime label="Awake" minutes={night.minutesAwake} />
      </View>
      {night.stages.length === 0 ? (
        <Text style={styles.meta}>No stage breakdown for this night.</Text>
      ) : (
        <>
          <View style={styles.hypnogram}>
            {night.stages.map((stage, index) => (
              <View
                key={`${stage.startedAt}-${index}`}
                style={[
                  styles.stageBar,
                  {
                    backgroundColor: stageColor[stage.stage],
                    flexGrow: stage.minutes,
                    height: stageHeight[stage.stage],
                  },
                ]}
              />
            ))}
          </View>
          <View style={styles.legend}>
            {legend.map((stage) => (
              <View key={stage} style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: stageColor[stage] }]} />
                <Text style={styles.meta}>{stageLabel[stage]}</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function StageTime({ label, minutes }: { label: string; minutes: number }) {
  return (
    <View style={styles.stageStat}>
      <Text style={styles.stageValue}>{formatDuration(minutes)}</Text>
      <Text style={styles.meta}>{label}</Text>
    </View>
  );
}

function nightDateLabel(night: SleepNight): string {
  const start = new Date(night.startedAt);
  const end = new Date(night.endedAt);
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const startLabel = start.toLocaleDateString(undefined, options);
  const endLabel = end.toLocaleDateString(undefined, options);
  if (start.toDateString() === end.toDateString()) return startLabel;
  return `${startLabel} – ${endLabel}`;
}

function qualityColor(label: string): string {
  if (label === 'Excellent' || label === 'Good') return colors.ok;
  if (label === 'Fair') return WARN;
  return colors.danger;
}

function isSameUtcDay(timestamp: string, now = new Date()): boolean {
  const date = new Date(timestamp);
  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function seriesForChart(samples: HeartRateSample[]): number[] {
  const ordered = [...samples].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const today = ordered.filter((sample) => isSameUtcDay(sample.timestamp));
  const chosen = today.length > 0 ? today : ordered;
  return downsample(
    chosen.map((sample) => sample.bpm),
    SPARK_POINTS,
  );
}

function heartCaption(samples: HeartRateSample[]): string | null {
  if (samples.length === 0) return null;
  return samples.some((sample) => isSameUtcDay(sample.timestamp)) ? 'Today, UTC' : 'Recent';
}

function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const sampled: number[] = [];
  const step = (values.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(values[Math.round(index * step)] ?? 0);
  }
  return sampled;
}

function sparkHeight(bpm: number): number {
  const clamped = Math.max(40, Math.min(180, bpm));
  return 4 + ((clamped - 40) / 140) * 52;
}

function oxygenBand(spo2: number): { label: string; color: string } {
  if (spo2 < 90) return { label: 'Low', color: colors.danger };
  if (spo2 < 95) return { label: 'Borderline', color: WARN };
  return { label: 'Fine', color: colors.ok };
}

function markerPercent(spo2: number): number {
  const clamped = Math.max(85, Math.min(100, spo2));
  return ((clamped - 85) / 15) * 100;
}

function tempZone(celsius: number): { label: string; color: string } {
  if (celsius < 36) return { label: 'Too cold', color: COLD };
  if (celsius >= 37.5) return { label: 'Too hot', color: colors.danger };
  return { label: 'Just right', color: colors.ok };
}

function temperatureFraction(celsius: number): number {
  return Math.max(0, Math.min(1, (celsius - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)));
}

const styles = StyleSheet.create({
  block: {
    gap: 8,
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  meta: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  caption: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  activityRow: {
    flexDirection: 'row',
    gap: 16,
    justifyContent: 'space-evenly',
  },
  activityStat: {
    alignItems: 'center',
    flex: 1,
    gap: 6,
  },
  activityCircle: {
    alignItems: 'center',
    alignSelf: 'center',
    aspectRatio: 1,
    backgroundColor: colors.bg,
    borderColor: colors.accent,
    borderRadius: 999,
    borderWidth: 3,
    justifyContent: 'center',
    maxWidth: 148,
    paddingHorizontal: 12,
    width: '100%',
  },
  activityValue: {
    color: colors.text,
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    textAlign: 'center',
  },
  shoe: {
    height: 40,
    marginTop: 4,
    width: 76,
  },
  shoeHeel: {
    borderBottomWidth: 0,
    borderColor: colors.accent,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 5,
    borderWidth: 2,
    height: 24,
    position: 'absolute',
    right: 6,
    top: 6,
    width: 16,
  },
  shoeUpper: {
    borderBottomWidth: 0,
    borderColor: colors.accent,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 10,
    borderWidth: 2,
    height: 18,
    left: 8,
    position: 'absolute',
    top: 12,
    width: 58,
  },
  shoeToe: {
    borderBottomLeftRadius: 8,
    borderBottomWidth: 0,
    borderColor: colors.accent,
    borderRightWidth: 0,
    borderTopLeftRadius: 12,
    borderWidth: 2,
    height: 16,
    left: 2,
    position: 'absolute',
    top: 16,
    width: 22,
  },
  shoeLace: {
    backgroundColor: colors.accent,
    height: 2,
    left: 26,
    position: 'absolute',
    top: 18,
    width: 14,
  },
  shoeSole: {
    borderColor: colors.accent,
    borderRadius: 5,
    borderWidth: 2,
    bottom: 2,
    height: 8,
    left: 0,
    position: 'absolute',
    width: 76,
  },
  flame: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'flex-end',
    marginTop: 4,
    width: 28,
  },
  flameOuter: {
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 10,
    borderColor: '#ff8a3d',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 14,
    borderWidth: 2,
    height: 28,
    transform: [{ rotate: '8deg' }],
    width: 18,
  },
  flameInner: {
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    borderColor: '#ffb020',
    borderTopLeftRadius: 8,
    borderTopRightRadius: 6,
    borderWidth: 2,
    bottom: 6,
    height: 14,
    left: 10,
    position: 'absolute',
    width: 8,
  },
  scaleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  scaleLabel: {
    color: colors.muted,
    fontSize: 11,
  },
  vitalValue: {
    color: colors.text,
    fontSize: 40,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  heartRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
  },
  sparkWrap: {
    flex: 1,
    gap: 4,
    minWidth: 120,
  },
  spark: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 2,
    height: 64,
  },
  sparkBar: {
    backgroundColor: colors.accent,
    borderRadius: 2,
    flexBasis: 0,
    flexGrow: 1,
    maxWidth: 8,
    minWidth: 2,
  },
  sparkBaseline: {
    backgroundColor: colors.line,
    height: 1,
  },
  meter: {
    height: 22,
    justifyContent: 'center',
    marginTop: 4,
  },
  track: {
    borderRadius: 999,
    flexDirection: 'row',
    height: 14,
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
  },
  needle: {
    backgroundColor: colors.text,
    borderRadius: 2,
    height: 22,
    marginLeft: -2,
    position: 'absolute',
    top: 0,
    width: 4,
  },
  thermoRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
  },
  ticks: {
    height: 168,
    width: 44,
  },
  tick: {
    color: colors.muted,
    fontSize: 11,
    position: 'absolute',
    right: 0,
  },
  tickTop: {
    top: 0,
  },
  tickHot: {
    marginTop: -8,
    top: '50%',
  },
  tickComfort: {
    marginTop: -8,
    top: '80%',
  },
  tickBottom: {
    bottom: 0,
  },
  thermoColumn: {
    alignItems: 'center',
    width: 36,
  },
  tube: {
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderRadius: 18,
    borderWidth: 1,
    height: 168,
    overflow: 'hidden',
    width: 36,
  },
  zone: {
    left: 0,
    position: 'absolute',
    right: 0,
  },
  hotZone: {
    backgroundColor: 'rgba(255,139,120,0.45)',
    height: '50%',
    top: 0,
  },
  comfortZone: {
    backgroundColor: 'rgba(155,231,176,0.35)',
    height: '30%',
    top: '50%',
  },
  coldZone: {
    backgroundColor: 'rgba(110,168,255,0.45)',
    height: '20%',
    top: '80%',
  },
  stem: {
    backgroundColor: '#000000',
    borderRadius: 6,
    bottom: 8,
    left: 12,
    position: 'absolute',
    top: 8,
    width: 12,
    zIndex: 1,
  },
  mercury: {
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5,
    bottom: 0,
    left: 13,
    position: 'absolute',
    width: 10,
    zIndex: 2,
  },
  bulb: {
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    height: 28,
    marginTop: -12,
    width: 28,
  },
  thermoReading: {
    flex: 1,
    gap: 2,
    justifyContent: 'center',
    minHeight: 168,
  },
  nightDate: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  nightRange: {
    color: colors.text,
    fontSize: 16,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 12,
  },
  summaryStat: {
    flex: 1,
    gap: 2,
  },
  summaryValue: {
    color: colors.text,
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  stageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  stageStat: {
    flexGrow: 1,
    gap: 2,
    minWidth: '40%',
  },
  stageValue: {
    color: colors.text,
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  hypnogram: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 2,
    height: 64,
    marginTop: 4,
  },
  stageBar: {
    borderRadius: 3,
    flexBasis: 0,
    minWidth: 3,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  legendItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  swatch: {
    borderRadius: 4,
    height: 10,
    width: 10,
  },
});
