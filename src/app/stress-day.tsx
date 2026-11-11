import { useNavigation, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { StressDayPlot } from '../components/readings';
import { colors } from '../components/ui';
import { stressBand, stressHistoryDays, type StressHistoryDay } from '../model';
import { useAppState } from '../state/AppProvider';

export default function StressDayScreen() {
  const { day } = useLocalSearchParams<{ day?: string | string[] }>();
  const key = firstParam(day);
  const navigation = useNavigation();
  const { lastPayload } = useAppState();
  const record = useMemo(() => {
    const days = stressHistoryDays(lastPayload?.stress ?? [], lastPayload?.sleep ?? []);
    return days.find((item) => item.key === key) ?? null;
  }, [key, lastPayload?.sleep, lastPayload?.stress]);
  const date = dateFromKey(key);
  const title = date
    ? date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : 'Stress';

  useEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.date}>{title}</Text>
      {record ? <DayDetail record={record} /> : <Text style={styles.meta}>No daytime stress for this day.</Text>}
    </ScrollView>
  );
}

function DayDetail({ record }: { record: StressHistoryDay }) {
  return (
    <>
      <View style={styles.summaryRow}>
        <Stat label="Average" value={`${record.average}`} />
        <Stat label="Peak" value={`${record.peak}`} />
        <Stat label="Minimum" value={`${record.minimum}`} />
      </View>
      <Text style={styles.meta}>{stressBand(record.average)}</Text>
      <StressDayPlot samples={record.samples} />
      <Text style={styles.meta}>Daytime samples saved from the ring, from midnight to midnight.</Text>
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

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function dateFromKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
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
  meta: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
});
