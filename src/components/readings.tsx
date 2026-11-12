import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import {
  activityForLocalDay,
  latestMetric,
  stressBand,
  type MetricSample,
  type SleepNight,
  type SleepStageName,
  type StepSample,
  type StressSummary,
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
import { debtForNight, scoreSleepNight, sleepDebtLabel } from '../sleepScore';
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
  return nights.reduce((latest, night) => (night.startedAt > latest.startedAt ? night : latest));
}


export function ActivityChart({
  steps,
  stress = [],
  sleep = [],
}: {
  steps: StepSample[];
  stress?: MetricSample[];
  sleep?: SleepNight[];
}) {
  const today = activityForLocalDay(steps);
  const latestStress = latestMetric(stress);
  const night = latestNight(sleep);
  const quality = night ? scoreSleepNight(night) : null;

  return (
    <View style={styles.activityBlock}>
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
          caption={latestStress ? stressBand(latestStress.value) : '—'}
          icon="💓"
          label="Stress"
          value={latestStress ? `${latestStress.value}` : '—'}
        />
        <ActivityStat
          caption={quality ? quality.label : '—'}
          icon="🌙"
          label="Sleep"
          value={quality ? `${quality.score}` : '—'}
        />
      </View>
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
      <Text style={styles.activityLabel}>{label}</Text>
    </View>
  );
}

const STRESS_TICKS = [100, 75, 50, 25, 0];

export function StressPanel({
  summary,
  live,
  points,
  reading,
}: {
  summary: StressSummary;
  live: number | null;
  points?: number[];
  reading?: MetricSample | null;
}) {
  const series = points ?? summary.today.map((sample) => sample.value);
  const value = live ?? reading?.value ?? summary.current?.value ?? null;
  const band =
    live !== null ? stressBand(live) : reading ? stressBand(reading.value) : (summary.current?.band ?? null);
  const baselines = baselineLine(summary);

  return (
    <View style={styles.block}>
      <View style={styles.heartReadout}>
        <View>
          <Text style={styles.vitalValue}>{value === null ? '—' : `${value}`}</Text>
          <Text style={styles.meta}>{band ?? '0–99'}</Text>
        </View>
      </View>
      {series.length === 0 ? (
        <Text style={styles.meta}>{points ? 'No stress yet today.' : 'No daytime stress yet.'}</Text>
      ) : (
        <SeriesLine max={100} min={0} points={series} ticks={STRESS_TICKS} />
      )}
      <View style={styles.summaryRow}>
        <View style={styles.summaryStat}>
          <Text style={styles.summaryValue}>{summary.average ?? '—'}</Text>
          <Text style={styles.meta}>Today</Text>
        </View>
        <View style={styles.summaryStat}>
          <Text style={styles.summaryValue}>{summary.peak ?? '—'}</Text>
          <Text style={styles.meta}>Peak</Text>
        </View>
        <View style={styles.summaryStat}>
          <Text style={styles.summaryValue}>{summary.today.length === 0 ? '—' : formatDuration(summary.highMinutes)}</Text>
          <Text style={styles.meta}>High</Text>
        </View>
        <View style={styles.summaryStat}>
          <Text adjustsFontSizeToFit numberOfLines={1} style={styles.summaryValue}>
            {summary.trend ?? '—'}
          </Text>
          <Text style={styles.meta}>Trend</Text>
        </View>
      </View>
      {summary.today.length === 0 ? null : (
        <Text style={styles.meta}>
          {`Relaxed ${summary.distribution.Relaxed}% · Low ${summary.distribution.Low}% · Moderate ${summary.distribution.Moderate}% · High ${summary.distribution.High}%`}
        </Text>
      )}
      {baselines ? <Text style={styles.meta}>{baselines}</Text> : null}
      <Text style={styles.meta}>
        {summary.overnight === null ? 'No overnight reading.' : `Overnight ${summary.overnight}`}
      </Text>
    </View>
  );
}

const DAY_MINUTES = 24 * 60;
const DAY_HOURS = [0, 6, 12, 18];

export function StressDayPlot({ samples }: { samples: MetricSample[] }) {
  const [plotWidth, setPlotWidth] = useState(0);
  const yFor = (value: number) => {
    const clamped = Math.max(0, Math.min(100, value));
    const inset = 8;
    return inset + ((100 - clamped) / 100) * (CHART_HEIGHT - inset * 2);
  };
  const xFor = (minutes: number) => {
    const inset = 6;
    if (plotWidth <= inset * 2) return inset;
    return inset + (minutes / DAY_MINUTES) * (plotWidth - inset * 2);
  };
  const coords =
    plotWidth === 0
      ? []
      : samples.map((sample) => ({
          x: xFor(minutesOfDay(sample.timestamp)),
          y: yFor(sample.value),
        }));

  return (
    <View style={styles.bpmScaleRow}>
      <View style={styles.bpmAxis}>
        {STRESS_TICKS.map((tick) => (
          <Text key={tick} style={[styles.bpmTick, { top: yFor(tick) - 7 }]}>
            {tick}
          </Text>
        ))}
      </View>
      <View style={styles.dayPlotColumn}>
        <View style={styles.bpmPlot} onLayout={(event) => setPlotWidth(event.nativeEvent.layout.width)}>
          {STRESS_TICKS.map((tick) => (
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
        <View style={styles.dayHours}>
          {plotWidth === 0
            ? null
            : DAY_HOURS.map((hour) => (
                <Text key={hour} style={[styles.dayHour, { left: Math.max(0, xFor(hour * 60) - 12) }]}>
                  {hourLabel(hour)}
                </Text>
              ))}
        </View>
      </View>
    </View>
  );
}

function minutesOfDay(timestamp: string): number {
  const date = new Date(timestamp);
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function hourLabel(hour: number): string {
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  if (hour < 12) return `${hour}a`;
  return `${hour - 12}p`;
}

function baselineLine(summary: StressSummary): string | null {
  const parts: string[] = [];
  if (summary.week) {
    const label = summary.week.days >= 7 ? '7-day' : `${summary.week.days}-day`;
    parts.push(`${label} ${summary.week.value}`);
  }
  if (summary.month) {
    const label = summary.month.days >= 30 ? '30-day' : `${summary.month.days}-day`;
    parts.push(`${label} ${summary.month.value}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
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
        <Text style={styles.meta}>{live ? 'Measuring. The first beat takes a few seconds.' : 'No heart rate yet today.'}</Text>
      ) : (
        <SeriesLine max={SCALE_MAX} min={SCALE_MIN} points={points} ticks={SCALE_TICKS} />
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

function SeriesLine({
  points,
  min,
  max,
  ticks,
}: {
  points: number[];
  min: number;
  max: number;
  ticks: number[];
}) {
  const [plotWidth, setPlotWidth] = useState(0);
  const capacity = Math.max(1, Math.floor(plotWidth / BEAT_SLOT));
  const visible = plotWidth === 0 ? [] : points.slice(-capacity);
  const yFor = (value: number) => {
    const clamped = Math.max(min, Math.min(max, value));
    const inset = 8;
    return inset + ((max - clamped) / (max - min)) * (CHART_HEIGHT - inset * 2);
  };
  const coords = visible.map((value, index) => ({ x: index * BEAT_SLOT + BEAT_SLOT / 2, y: yFor(value) }));

  return (
    <View style={styles.bpmScaleRow}>
      <View style={styles.bpmAxis}>
        {ticks.map((tick) => (
          <Text key={tick} style={[styles.bpmTick, { top: yFor(tick) - 7 }]}>
            {tick}
          </Text>
        ))}
      </View>
      <View style={styles.bpmPlot} onLayout={(event) => setPlotWidth(event.nativeEvent.layout.width)}>
        {ticks.map((tick) => (
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

export function SleepNightSummary({ night, nights }: { night: SleepNight; nights?: SleepNight[] }) {
  const quality = scoreSleepNight(night);
  const debtMinutes = debtForNight(nights ?? [night], night);
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
          <Text style={styles.meta}>{sleepDebtLabel(debtMinutes)}</Text>
        </View>
      </View>
      {quality.endedInDeepSleep ? <Text style={styles.meta}>Ended in deep sleep</Text> : null}
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

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

export function oxygenBand(spo2: number): { label: string; color: string } {
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
    fontSize: 11,
    lineHeight: 14,
  },
  activityBlock: {
    gap: 4,
  },
  activityRow: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-evenly',
  },
  activityStat: {
    alignItems: 'center',
    flex: 1,
    gap: 2,
  },
  activityCircle: {
    alignItems: 'center',
    alignSelf: 'center',
    aspectRatio: 1,
    backgroundColor: colors.bg,
    borderColor: colors.accent,
    borderRadius: 999,
    borderWidth: 2,
    justifyContent: 'center',
    maxWidth: 96,
    paddingHorizontal: 6,
    width: '100%',
  },
  activityValue: {
    color: colors.text,
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    textAlign: 'center',
  },
  activityIcon: {
    fontSize: 16,
    lineHeight: 20,
  },
  activityLabel: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
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
  dayPlotColumn: {
    flex: 1,
    gap: 4,
  },
  dayHours: {
    height: 16,
  },
  dayHour: {
    color: colors.muted,
    fontSize: 11,
    position: 'absolute',
    top: 0,
    width: 28,
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
