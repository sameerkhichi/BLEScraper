import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  heartRateHistoryDays,
  spo2HistoryDays,
  temperatureHistoryDays,
  type ReadingHistoryDay,
  type UploadPayload,
} from '../model';
import { temperatureZone } from '../sync/temperatureAlert';
import { useAppState } from '../state/AppProvider';
import { firstHistoryParam, historyDateTitle, MonthHistory, type HistoryCell } from './monthHistory';
import { formatClock, oxygenBand } from './readings';
import { colors } from './ui';

export type VitalKind = 'heart' | 'oxygen' | 'temperature';

const VITALS: Record<
  VitalKind,
  {
    title: string;
    intro: string;
    emptyMonth: string;
    emptyDay: string;
    footnote: string;
    dayPath: '/heart-day' | '/oxygen-day' | '/temperature-day';
    formatPrimary: (value: number) => string;
    formatExtreme: (value: number) => string;
    formatSample: (value: number) => string;
    color: (average: number) => string;
  }
> = {
  heart: {
    title: 'Heart rate',
    intro: 'Each day shows the average heart rate, then the peak and the minimum. Days the phone never stored stay empty.',
    emptyMonth: 'No heart rate saved for this month.',
    emptyDay: 'No heart rate for this day.',
    footnote: 'Heart-rate samples saved on the phone, from midnight to midnight.',
    dayPath: '/heart-day',
    formatPrimary: (value) => `${value}`,
    formatExtreme: (value) => `${value}`,
    formatSample: (value) => `${value} bpm`,
    color: () => colors.accent,
  },
  oxygen: {
    title: 'Blood oxygen',
    intro: 'Each day shows the average blood oxygen, then the peak and the minimum. Days the phone never stored stay empty.',
    emptyMonth: 'No blood oxygen saved for this month.',
    emptyDay: 'No blood oxygen for this day.',
    footnote: 'Blood-oxygen samples saved on the phone, from midnight to midnight.',
    dayPath: '/oxygen-day',
    formatPrimary: (value) => `${value}`,
    formatExtreme: (value) => `${value}`,
    formatSample: (value) => `${value}%`,
    color: (average) => oxygenBand(average).color,
  },
  temperature: {
    title: 'Body temperature',
    intro:
      'Each day shows the average body temperature, then the peak and the minimum. Days the phone never stored stay empty.',
    emptyMonth: 'No body temperature saved for this month.',
    emptyDay: 'No body temperature for this day.',
    footnote: 'Temperature samples saved on the phone, from midnight to midnight.',
    dayPath: '/temperature-day',
    formatPrimary: (value) => value.toFixed(1),
    formatExtreme: (value) => value.toFixed(1),
    formatSample: (value) => `${value.toFixed(1)}°C`,
    color: (average) => temperatureColor(average),
  },
};

export function VitalHistory({ kind }: { kind: VitalKind }) {
  const { lastPayload } = useAppState();
  const copy = VITALS[kind];
  const days = useMemo(() => historyCells(kind, lastPayload), [kind, lastPayload]);

  return (
    <MonthHistory
      days={days}
      emptyMessage={copy.emptyMonth}
      intro={copy.intro}
      onOpenDay={(key) => router.push({ pathname: copy.dayPath, params: { day: key } })}
    />
  );
}

export function VitalDay({ kind }: { kind: VitalKind }) {
  const { day } = useLocalSearchParams<{ day?: string | string[] }>();
  const key = firstHistoryParam(day);
  const navigation = useNavigation();
  const { lastPayload } = useAppState();
  const copy = VITALS[kind];
  const record = useMemo(() => {
    return readingsFor(kind, lastPayload).find((item) => item.key === key) ?? null;
  }, [key, kind, lastPayload]);
  const title = historyDateTitle(key, copy.title);

  useEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.date}>{title}</Text>
      {record ? (
        <DayDetail copy={copy} record={record} />
      ) : (
        <Text style={styles.meta}>{copy.emptyDay}</Text>
      )}
    </ScrollView>
  );
}

function DayDetail({
  copy,
  record,
}: {
  copy: (typeof VITALS)[VitalKind];
  record: ReadingHistoryDay;
}) {
  return (
    <>
      <View style={styles.summaryRow}>
        <Stat label="Average" value={copy.formatPrimary(record.average)} />
        <Stat label="Peak" value={copy.formatExtreme(record.peak)} />
        <Stat label="Minimum" value={copy.formatExtreme(record.minimum)} />
      </View>
      {record.samples.map((sample, index) => (
        <View key={`${sample.timestamp}-${index}`} style={styles.row}>
          <Text style={styles.time}>{formatClock(sample.timestamp)}</Text>
          <Text style={styles.reading}>{copy.formatSample(sample.value)}</Text>
        </View>
      ))}
      <Text style={styles.meta}>{copy.footnote}</Text>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.meta}>{label}</Text>
    </View>
  );
}

function historyCells(kind: VitalKind, payload: UploadPayload | null): HistoryCell[] {
  const copy = VITALS[kind];
  return readingsFor(kind, payload).map((day) => ({
    key: day.key,
    primary: copy.formatPrimary(day.average),
    secondary: `${copy.formatExtreme(day.peak)}–${copy.formatExtreme(day.minimum)}`,
    color: copy.color(day.average),
    detail: `average ${copy.formatPrimary(day.average)}, peak ${copy.formatExtreme(day.peak)}, minimum ${copy.formatExtreme(day.minimum)}`,
  }));
}

function readingsFor(kind: VitalKind, payload: UploadPayload | null): ReadingHistoryDay[] {
  if (kind === 'heart') return heartRateHistoryDays(payload?.heartRate ?? []);
  if (kind === 'oxygen') return spo2HistoryDays(payload?.vitalSpots ?? []);
  return temperatureHistoryDays(payload?.vitalSpots ?? []);
}

function temperatureColor(celsius: number): string {
  const tone = temperatureZone(celsius).tone;
  if (tone === 'ok') return colors.ok;
  if (tone === 'warn') return '#f0c36a';
  return colors.danger;
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    gap: 14,
    padding: 20,
    paddingBottom: 40,
  },
  date: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 12,
  },
  stat: {
    flex: 1,
    gap: 2,
  },
  value: {
    color: colors.text,
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  time: {
    color: colors.muted,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  reading: {
    color: colors.text,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  meta: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
});
