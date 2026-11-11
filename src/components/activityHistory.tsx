import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { activityHistoryDays, type ActivityHistoryDay } from '../model';
import { useAppState } from '../state/AppProvider';
import { firstHistoryParam, historyDateTitle, MonthHistory, type HistoryCell } from './monthHistory';
import { formatClock, formatCount, formatDistance } from './readings';
import { colors } from './ui';

export function ActivityHistory() {
  const { lastPayload } = useAppState();
  const days = useMemo<HistoryCell[]>(() => {
    return activityHistoryDays(lastPayload?.steps ?? []).map((day) => {
      const steps = formatCount(day.steps);
      const distance = formatDistance(day.distanceMeters);
      const calories = formatCount(day.calories);
      return {
        key: day.key,
        primary: steps,
        secondary: `${distance} · ${calories} cal`,
        color: colors.accent,
        detail: `${steps} steps, ${distance}, ${calories} calories`,
      };
    });
  }, [lastPayload?.steps]);

  return (
    <MonthHistory
      days={days}
      emptyMessage="No steps saved for this month."
      intro="Each day shows the steps, then the distance and calories. Days the phone never stored stay empty."
      onOpenDay={(key) => router.push({ pathname: '/activity-day', params: { day: key } })}
    />
  );
}

export function ActivityDay() {
  const { day } = useLocalSearchParams<{ day?: string | string[] }>();
  const key = firstHistoryParam(day);
  const navigation = useNavigation();
  const { lastPayload } = useAppState();
  const record = useMemo(() => {
    return activityHistoryDays(lastPayload?.steps ?? []).find((item) => item.key === key) ?? null;
  }, [key, lastPayload?.steps]);
  const title = historyDateTitle(key, 'Activity');

  useEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.date}>{title}</Text>
      {record ? <DayDetail record={record} /> : <Text style={styles.meta}>No steps for this day.</Text>}
    </ScrollView>
  );
}

function DayDetail({ record }: { record: ActivityHistoryDay }) {
  return (
    <>
      <View style={styles.summaryRow}>
        <Stat label="Steps" value={formatCount(record.steps)} />
        <Stat label="Distance" value={formatDistance(record.distanceMeters)} />
        <Stat label="Calories" value={formatCount(record.calories)} />
      </View>
      {record.samples.map((sample, index) => (
        <View key={`${sample.timestamp}-${index}`} style={styles.row}>
          <Text style={styles.time}>{formatClock(sample.timestamp)}</Text>
          <Text style={styles.reading}>
            {`${formatCount(sample.steps)} steps · ${formatDistance(sample.distanceMeters)} · ${formatCount(sample.calories)} cal`}
          </Text>
        </View>
      ))}
      <Text style={styles.meta}>Step blocks saved on the phone, from midnight to midnight.</Text>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text adjustsFontSizeToFit numberOfLines={1} style={styles.value}>
        {value}
      </Text>
      <Text style={styles.meta}>{label}</Text>
    </View>
  );
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
    gap: 12,
    justifyContent: 'space-between',
  },
  time: {
    color: colors.muted,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  reading: {
    color: colors.text,
    flexShrink: 1,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    textAlign: 'right',
  },
  meta: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
});
