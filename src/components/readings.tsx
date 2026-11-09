import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import {
  activityForLocalDay,
  restingLoad,
  type HeartRateSample,
  type RestingLoad,
  type SleepNight,
  type SleepStageName,
  type StepSample,
} from '../model';
import {
  FEVER_C,
  MILD_HYPOTHERMIA_C,
  MODERATE_HYPOTHERMIA_C,
  SEVERE_HYPOTHERMIA_C,
  fahrenheit,
  temperatureZone,
  type TemperatureTone,
} from '../sync/temperatureAlert';
import { colors } from './ui';

const WARN = '#f0c36a';
const TEMP_MIN = 24;
const TEMP_MAX = 40;
const TEMP_TICKS = [40, FEVER_C, MILD_HYPOTHERMIA_C, MODERATE_HYPOTHERMIA_C, SEVERE_HYPOTHERMIA_C];
const TEMP_BANDS = [
  { high: TEMP_MAX, low: FEVER_C, color: 'rgba(255,139,120,0.45)' },
  { high: FEVER_C, low: MILD_HYPOTHERMIA_C, color: 'rgba(155,231,176,0.35)' },
  { high: MILD_HYPOTHERMIA_C, low: MODERATE_HYPOTHERMIA_C, color: 'rgba(240,195,106,0.4)' },
  { high: MODERATE_HYPOTHERMIA_C, low: SEVERE_HYPOTHERMIA_C, color: 'rgba(255,159,110,0.45)' },
  { high: SEVERE_HYPOTHERMIA_C, low: TEMP_MIN, color: 'rgba(255,107,107,0.5)' },
];
const CHART_HEIGHT = 148;
const SCALE_MIN = 40;
const SCALE_MAX = 200;
const SCALE_TICKS = [200, 160, 120, 80, 40];
const BEAT_SLOT = 18;

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

export function formatTaken(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `Taken ${time}`;
  const day = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `Taken ${day}, ${time}`;
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

export function ActivityChart({
  steps,
  heartRate = [],
  sleep = [],
}: {
  steps: StepSample[];
  heartRate?: HeartRateSample[];
  sleep?: SleepNight[];
}) {
  const today = activityForLocalDay(steps);
  const load = restingLoad(heartRate, steps, sleep);
  const night = latestNight(sleep);
  const quality = night ? sleepQuality(night) : null;

  return (
    <View style={styles.block}>
      <Text style={styles.label}>Today</Text>
      <View style={styles.activityRow}>
        <ActivityStat
          caption={formatDistance(today.distanceMeters)}
          icon="👟"
          label="Steps"
          value={formatCount(today.steps)}
        />
        <ActivityStat caption={'\u00a0'} icon="🔥" label="Calories" value={formatCount(today.calories)} />
      </View>
      <View style={styles.activityRow}>
        <ActivityStat
          caption={load.status === 'scored' ? load.band : '—'}
          icon="💓"
          label="Stress"
          value={load.status === 'scored' ? `${load.score}` : '—'}
        />
        <ActivityStat
          caption={quality ? quality.label : '—'}
          icon="🌙"
          label="Sleep"
          value={quality ? `${quality.score}` : '—'}
        />
      </View>
      <Text style={[styles.meta, styles.stressLine]}>{stressContext(load)}</Text>
    </View>
  );
}

function ActivityStat({
  value,
  caption,
  icon,
  label,
}: {
  value: string;
  caption: string;
  icon: string;
  label: string;
}) {
  return (
    <View style={styles.activityStat}>
      <View style={styles.activityCircle}>
        <Text adjustsFontSizeToFit numberOfLines={1} style={styles.activityValue}>
          {value}
        </Text>
      </View>
      <Text style={styles.caption}>{caption}</Text>
      <Text style={styles.activityIcon}>{icon}</Text>
      <Text style={styles.meta}>{label}</Text>
    </View>
  );
}

function stressContext(load: RestingLoad): string {
  if (load.status === 'need-still') return 'Need 30 minutes still today.';
  if (load.status === 'need-baseline') return "Need last night's heart rate.";
  return `Still ${load.stillBpm} bpm · sleep ${load.baselineBpm} · ${formatDuration(load.stillMinutes)}`;
}

export function HeartRateChart({
  bpm,
  points,
  live,
}: {
  bpm: number | null;
  points: number[];
  live: boolean;
}) {
  return (
    <View style={styles.heartBlock}>
      <View style={styles.heartReadout}>
        <PulsingHeart bpm={live ? bpm : null} />
        <View>
          <Text style={styles.vitalValue}>{bpm == null ? '—' : `${bpm}`}</Text>
          <Text style={styles.meta}>bpm</Text>
        </View>
      </View>
      {points.length === 0 ? (
        <Text style={styles.meta}>{live ? 'Measuring. The first beat takes a few seconds.' : 'Measure to draw your heart rate.'}</Text>
      ) : (
        <BpmLine points={points} />
      )}
    </View>
  );
}

function PulsingHeart({ bpm }: { bpm: number | null }) {
  const scale = useRef(new Animated.Value(1)).current;
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;
  const beating = bpm !== null && bpm >= 30;

  useEffect(() => {
    if (!beating) {
      scale.setValue(1);
      return;
    }
    let stopped = false;
    const beat = () => {
      if (stopped) return;
      const rate = bpmRef.current;
      if (rate === null || rate < 30) return;
      const beatMs = Math.round(60000 / rate);
      const rise = Math.max(80, Math.round(beatMs * 0.22));
      const fall = Math.max(120, beatMs - rise);
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.28,
          duration: rise,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: fall,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished && !stopped) beat();
      });
    };
    beat();
    return () => {
      stopped = true;
      scale.stopAnimation();
    };
  }, [beating, scale]);

  return <Animated.Text style={[styles.heartGlyph, { transform: [{ scale }] }]}>❤️</Animated.Text>;
}

function BpmLine({ points }: { points: number[] }) {
  const [plotWidth, setPlotWidth] = useState(0);
  const capacity = Math.max(1, Math.floor(plotWidth / BEAT_SLOT));
  const visible = plotWidth === 0 ? [] : points.slice(-capacity);
  const yFor = (bpm: number) => {
    const clamped = Math.max(SCALE_MIN, Math.min(SCALE_MAX, bpm));
    const inset = 8;
    return inset + ((SCALE_MAX - clamped) / (SCALE_MAX - SCALE_MIN)) * (CHART_HEIGHT - inset * 2);
  };
  const coords = visible.map((bpm, index) => ({ x: index * BEAT_SLOT + BEAT_SLOT / 2, y: yFor(bpm) }));

  return (
    <View style={styles.bpmScaleRow}>
      <View style={styles.bpmAxis}>
        {SCALE_TICKS.map((tick) => (
          <Text key={tick} style={[styles.bpmTick, { top: yFor(tick) - 7 }]}>
            {tick}
          </Text>
        ))}
      </View>
      <View style={styles.bpmPlot} onLayout={(event) => setPlotWidth(event.nativeEvent.layout.width)}>
        {SCALE_TICKS.map((tick) => (
          <View key={tick} style={[styles.bpmGrid, { top: yFor(tick) }]} />
        ))}
        {coords.slice(1).map((point, index) => {
          const previous = coords[index];
          if (!previous) return null;
          const dx = point.x - previous.x;
          const dy = point.y - previous.y;
          const length = Math.hypot(dx, dy);
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          return (
            <View
              key={`line-${index}`}
              style={[
                styles.bpmSegment,
                {
                  left: (previous.x + point.x) / 2 - length / 2,
                  top: (previous.y + point.y) / 2 - 1,
                  width: length,
                  transform: [{ rotate: `${angle}deg` }],
                },
              ]}
            />
          );
        })}
        {coords.map((point, index) => {
          const latest = index === coords.length - 1;
          const size = latest ? 12 : 8;
          return (
            <View
              key={`node-${index}`}
              style={[
                styles.bpmNode,
                latest && styles.bpmNodeLatest,
                { height: size, left: point.x - size / 2, top: point.y - size / 2, width: size },
              ]}
            />
          );
        })}
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
  const zone = celsius == null ? null : temperatureZone(celsius);
  const mercuryColor = zone == null ? colors.line : toneColor(zone.tone);
  return (
    <View style={styles.thermoRow}>
      <View style={styles.ticks}>
        {TEMP_TICKS.map((mark) => {
          const top = (TEMP_MAX - mark) / (TEMP_MAX - TEMP_MIN);
          return (
            <Text key={mark} style={[styles.tick, { top: `${top * 100}%`, marginTop: top === 0 ? 0 : -7 }]}>
              {Number.isInteger(mark) ? `${mark}°` : `${mark.toFixed(1)}°`}
            </Text>
          );
        })}
      </View>
      <View style={styles.thermoColumn}>
        <View style={styles.tube}>
          {TEMP_BANDS.map((band) => (
            <View
              key={band.low}
              style={[
                styles.zone,
                {
                  backgroundColor: band.color,
                  top: temperatureTop(band.high),
                  height: temperatureHeight(band.low, band.high),
                },
              ]}
            />
          ))}
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
        <Text style={[styles.meta, zone ? { color: toneColor(zone.tone) } : null]}>
          {celsius == null || !zone ? 'Measure to fill this in.' : `${fahrenheit(celsius).toFixed(1)}°F · ${zone.label}`}
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

function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
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

function toneColor(tone: TemperatureTone): string {
  if (tone === 'ok') return colors.ok;
  if (tone === 'warn') return WARN;
  return colors.danger;
}

function temperatureTop(celsius: number): `${number}%` {
  return `${((TEMP_MAX - celsius) / (TEMP_MAX - TEMP_MIN)) * 100}%`;
}

function temperatureHeight(low: number, high: number): `${number}%` {
  return `${((high - low) / (TEMP_MAX - TEMP_MIN)) * 100}%`;
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
  stressLine: {
    textAlign: 'center',
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
  activityIcon: {
    fontSize: 28,
    lineHeight: 34,
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
  heartBlock: {
    gap: 12,
  },
  heartReadout: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  heartGlyph: {
    fontSize: 36,
    lineHeight: 42,
  },
  bpmScaleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  bpmAxis: {
    height: CHART_HEIGHT,
    width: 32,
  },
  bpmTick: {
    color: colors.muted,
    fontSize: 11,
    position: 'absolute',
    right: 0,
    textAlign: 'right',
    width: 32,
  },
  bpmPlot: {
    flex: 1,
    height: CHART_HEIGHT,
  },
  bpmGrid: {
    backgroundColor: colors.line,
    height: 1,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  bpmSegment: {
    backgroundColor: colors.accent,
    height: 2,
    position: 'absolute',
  },
  bpmNode: {
    backgroundColor: colors.bg,
    borderColor: colors.accent,
    borderRadius: 99,
    borderWidth: 2,
    position: 'absolute',
  },
  bpmNodeLatest: {
    backgroundColor: colors.accent,
    borderColor: colors.text,
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
    width: 48,
  },
  tick: {
    color: colors.muted,
    fontSize: 11,
    position: 'absolute',
    right: 0,
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
