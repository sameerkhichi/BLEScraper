import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../components/ui';
import { stressBand, stressDayKey, stressHistoryDays, type StressBand, type StressHistoryDay } from '../model';
import { useAppState } from '../state/AppProvider';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const bandColor: Record<StressBand, string> = {
  Relaxed: colors.ok,
  Low: '#8fd18a',
  Moderate: '#f0c36a',
  High: colors.danger,
};

type MonthCursor = {
  year: number;
  month: number;
};

export default function StressHistoryScreen() {
  const { lastPayload } = useAppState();
  const [cursor, setCursor] = useState<MonthCursor>(() => monthOf(new Date()));
  const now = new Date();
  const atCurrent = !isBefore(cursor, monthOf(now));
  const days = useMemo(
    () => stressHistoryDays(lastPayload?.stress ?? [], lastPayload?.sleep ?? []),
    [lastPayload?.sleep, lastPayload?.stress],
  );
  const byKey = useMemo(() => new Map(days.map((day) => [day.key, day])), [days]);
  const cells = monthCells(cursor.year, cursor.month);
  const title = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const todayKey = stressDayKey(now);
  const monthHasSamples = cells.some((cell) => {
    if (!cell.inMonth) return false;
    const key = stressDayKey(cell.date);
    return key !== null && byKey.has(key);
  });

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.body}>
        Each day shows the daytime average, then the peak and the minimum. Days the phone never stored stay empty.
      </Text>
      <View style={styles.pager}>
        <PagerButton
          accessibilityLabel="Previous year"
          label="‹‹"
          onPress={() => setCursor((current) => ({ year: current.year - 1, month: current.month }))}
        />
        <PagerButton
          accessibilityLabel="Previous month"
          label="‹"
          onPress={() => setCursor((current) => shiftMonth(current, -1))}
        />
        <Text accessibilityRole="header" style={styles.monthTitle}>
          {title}
        </Text>
        <PagerButton
          accessibilityLabel="Next month"
          disabled={atCurrent}
          label="›"
          onPress={() => setCursor((current) => shiftMonth(current, 1))}
        />
        <PagerButton
          accessibilityLabel="Next year"
          disabled={atCurrent}
          label="››"
          onPress={() => setCursor((current) => capYear(current, now))}
        />
      </View>
      <View style={styles.grid}>
        {WEEKDAYS.map((weekday) => (
          <Text key={weekday} style={styles.weekday}>
            {weekday}
          </Text>
        ))}
        {cells.map((cell) => {
          const key = stressDayKey(cell.date);
          const record = key && cell.inMonth ? byKey.get(key) : undefined;
          return (
            <DayCell
              date={cell.date}
              inMonth={cell.inMonth}
              key={key ?? cell.date.toISOString()}
              record={record}
              today={key !== null && key === todayKey}
            />
          );
        })}
      </View>
      {monthHasSamples ? null : <Text style={styles.meta}>No daytime stress saved for this month.</Text>}
    </ScrollView>
  );
}

function DayCell({
  date,
  inMonth,
  record,
  today,
}: {
  date: Date;
  inMonth: boolean;
  record: StressHistoryDay | undefined;
  today: boolean;
}) {
  const label = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const body = (
    <>
      <Text style={[styles.date, !inMonth && styles.outside]}>{date.getDate()}</Text>
      {record ? (
        <>
          <Text style={[styles.average, { color: bandColor[stressBand(record.average)] }]}>{record.average}</Text>
          <Text style={styles.range}>
            {record.peak}–{record.minimum}
          </Text>
        </>
      ) : null}
    </>
  );

  if (!record) {
    return <View style={[styles.cell, today && inMonth && styles.today]}>{body}</View>;
  }

  return (
    <Pressable
      accessibilityLabel={`${label}, average ${record.average}, peak ${record.peak}, minimum ${record.minimum}`}
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/stress-day', params: { day: record.key } })}
      style={[styles.cell, today && styles.today]}
    >
      {body}
    </Pressable>
  );
}

function PagerButton({
  label,
  accessibilityLabel,
  disabled = false,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={[styles.pagerButton, disabled && styles.pagerDisabled]}
    >
      <Text style={styles.pagerLabel}>{label}</Text>
    </Pressable>
  );
}

function monthOf(date: Date): MonthCursor {
  return { year: date.getFullYear(), month: date.getMonth() };
}

function isBefore(cursor: MonthCursor, limit: MonthCursor): boolean {
  return cursor.year < limit.year || (cursor.year === limit.year && cursor.month < limit.month);
}

function shiftMonth(cursor: MonthCursor, delta: number): MonthCursor {
  const date = new Date(cursor.year, cursor.month + delta, 1);
  return monthOf(date);
}

function capYear(cursor: MonthCursor, now: Date): MonthCursor {
  const limit = monthOf(now);
  const next = { year: cursor.year + 1, month: cursor.month };
  if (isBefore(next, limit) || (next.year === limit.year && next.month === limit.month)) return next;
  return limit;
}

function monthCells(year: number, month: number): { date: Date; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: weeks * 7 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return { date, inMonth: date.getMonth() === month };
  });
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    gap: 14,
    padding: 16,
    paddingBottom: 40,
  },
  body: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 22,
  },
  meta: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  pager: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  pagerButton: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  pagerDisabled: {
    opacity: 0.35,
  },
  pagerLabel: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  monthTitle: {
    color: colors.text,
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  weekday: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    width: '14.2857%',
  },
  cell: {
    alignItems: 'center',
    gap: 2,
    minHeight: 72,
    paddingHorizontal: 1,
    paddingVertical: 6,
    width: '14.2857%',
  },
  today: {
    borderColor: colors.accent,
    borderRadius: 8,
    borderWidth: 1,
  },
  date: {
    color: colors.muted,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  outside: {
    opacity: 0.35,
  },
  average: {
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  range: {
    color: colors.muted,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
});
