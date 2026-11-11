import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatClock, formatDuration, stageLabel } from '../components/readings';
import { Button, Card, colors } from '../components/ui';
import type { SleepCycle, SleepNight, SleepStage } from '../model';
import { annotateSleep, sleepDebtLabel, type ScoredSleepNight } from '../sleepScore';
import { useAppState } from '../state/AppProvider';

export default function SleepScreen() {
  const { busy, settings, lastPayload, sync } = useAppState();
  const nights = lastPayload?.sleep ?? [];
  const scored = annotateSleep(nights);
  const newestStart = scored.reduce((latest, night) => (night.startedAt > latest ? night.startedAt : latest), '');

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.body}>
        Sync reads the stages stored on the ring and posts them with the rest of the reading. A cycle runs through the next REM block.
      </Text>

      <Button
        disabled={busy}
        label="Sync ring"
        onPress={() => {
          if (!settings.ringId) {
            router.push('/scan');
            return;
          }
          void sync();
        }}
      />

      {scored.length === 0 ? (
        <Card>
          <Text style={styles.label}>No sleep yet</Text>
          <Text style={styles.meta}>Sync while the ring is nearby. The ring keeps about a week, and nights already saved stay on the phone.</Text>
        </Card>
      ) : (
        <SleepArchive newestStart={newestStart} nights={scored} />
      )}
    </ScrollView>
  );
}

function SleepArchive({ nights, newestStart }: { nights: ScoredSleepNight[]; newestStart: string }) {
  const { years, loose } = groupNights(nights);
  return (
    <>
      {years.map((year) => (
        <YearBlock key={year.year} newestStart={newestStart} year={year} />
      ))}
      {loose.map((night) => (
        <NightCard key={`${night.daysAgo}-${night.startedAt}`} newestStart={newestStart} night={night} />
      ))}
    </>
  );
}

function YearBlock({ year, newestStart }: { year: YearGroup; newestStart: string }) {
  const [open, setOpen] = useState(false);
  const nights = year.months.reduce((sum, month) => sum + month.nights.length, 0);

  return (
    <View style={styles.group}>
      <Card>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
        >
          <Text style={styles.date}>{year.year}</Text>
          <Text style={styles.meta}>
            {countLabel(year.months.length, 'month')} · {countLabel(nights, 'night')}
          </Text>
          <Text style={styles.meta}>{open ? 'Hide months' : 'Show months'}</Text>
        </Pressable>
      </Card>
      {open
        ? year.months.map((month) => (
            <MonthBlock key={month.month} month={month} newestStart={newestStart} year={year.year} />
          ))
        : null}
    </View>
  );
}

function MonthBlock({
  year,
  month,
  newestStart,
}: {
  year: number;
  month: MonthGroup;
  newestStart: string;
}) {
  const [open, setOpen] = useState(false);
  const name = new Date(year, month.month, 1).toLocaleDateString(undefined, { month: 'long' });

  return (
    <View style={styles.group}>
      <Card style={styles.monthHeader}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
        >
          <Text style={styles.date}>{name}</Text>
          <Text style={styles.meta}>{countLabel(month.nights.length, 'night')}</Text>
          <Text style={styles.meta}>{open ? 'Hide nights' : 'Show nights'}</Text>
        </Pressable>
      </Card>
      {open
        ? month.nights.map((night) => (
            <NightCard key={`${night.daysAgo}-${night.startedAt}`} newestStart={newestStart} night={night} />
          ))
        : null}
    </View>
  );
}

function NightCard({ night, newestStart }: { night: ScoredSleepNight; newestStart: string }) {
  const showDebt = night.startedAt === newestStart;
  const [open, setOpen] = useState(false);
  const [openCycle, setOpenCycle] = useState<number | null>(null);
  const longestAwake = night.stages.reduce(
    (longest, stage) => (stage.stage === 'awake' ? Math.max(longest, stage.minutes) : longest),
    0,
  );

  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
      >
        <Text style={styles.date}>{nightDateLabel(night)}</Text>
        <Text style={styles.meta}>
          {formatClock(night.startedAt)} – {formatClock(night.endedAt)}
        </Text>
        <View style={styles.summaryRow}>
          <View>
            <Text style={styles.summaryValue}>{formatDuration(night.minutesAsleep)}</Text>
            <Text style={styles.meta}>Asleep</Text>
          </View>
          <View>
            <Text style={[styles.summaryValue, { color: scoreColor(night.scoreLabel) }]}>{night.score}</Text>
            <Text style={styles.meta}>{`${night.scoreLabel} · estimated`}</Text>
          </View>
        </View>
        {showDebt ? <Text style={styles.meta}>{sleepDebtLabel(night.sleepDebtMinutes)}</Text> : null}
        {night.endedInDeepSleep ? <Text style={styles.meta}>Ended in deep sleep</Text> : null}
        <Text style={styles.meta}>{open ? 'Hide cycles' : 'Show cycles'}</Text>
      </Pressable>

      {open ? (
        <View style={styles.cycles}>
          {longestAwake > 0 ? <Text style={styles.meta}>{`Longest awake ${formatDuration(longestAwake)}`}</Text> : null}
          {night.cycles.length === 0 ? (
            night.stages.length === 0 ? (
              <Text style={styles.meta}>No cycles stored for this night.</Text>
            ) : (
              night.stages.map((stage, index) => (
                <Text key={`${stage.stage}-${stage.startedAt}-${index}`} style={styles.stageLine}>
                  {formatClock(stage.startedAt)} · {stageLabel[stage.stage]} · {formatDuration(stage.minutes)}
                </Text>
              ))
            )
          ) : (
            night.cycles.map((cycle) => {
              const expanded = openCycle === cycle.index;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  key={cycle.index}
                  onPress={() => setOpenCycle(expanded ? null : cycle.index)}
                >
                  <Text style={styles.cycleLine}>
                    {`Cycle ${cycle.index} · ${formatClock(cycle.startedAt)} – ${formatClock(cycle.endedAt)} · ${formatDuration(cycle.minutes)}${cycle.complete ? '' : ' · no REM'}`}
                  </Text>
                  <Text style={styles.meta}>{expanded ? 'Hide times' : 'Show times'}</Text>
                  {expanded ? <CycleStages cycle={cycle} stages={stagesInCycle(night, cycle)} /> : null}
                </Pressable>
              );
            })
          )}
        </View>
      ) : null}
    </Card>
  );
}

function CycleStages({ cycle, stages }: { cycle: SleepCycle; stages: SleepStage[] }) {
  if (stages.length === 0) {
    return <Text style={styles.stageLine}>No stage times stored for cycle {cycle.index}.</Text>;
  }
  return (
    <View>
      {stages.map((stage, index) => (
        <Text key={`${stage.stage}-${stage.startedAt}-${index}`} style={styles.stageLine}>
          {formatClock(stage.startedAt)} · {stageLabel[stage.stage]} · {formatDuration(stage.minutes)}
        </Text>
      ))}
    </View>
  );
}

function stagesInCycle(night: SleepNight, cycle: SleepCycle): SleepStage[] {
  const start = Date.parse(cycle.startedAt);
  const end = Date.parse(cycle.endedAt);
  return night.stages.filter((stage) => {
    const at = Date.parse(stage.startedAt);
    return Number.isFinite(at) && at >= start && at < end;
  });
}

type MonthGroup = { month: number; nights: ScoredSleepNight[] };
type YearGroup = { year: number; months: MonthGroup[] };

function groupNights(nights: ScoredSleepNight[]): { years: YearGroup[]; loose: ScoredSleepNight[] } {
  const byYear = new Map<number, Map<number, ScoredSleepNight[]>>();
  const loose: ScoredSleepNight[] = [];
  for (const night of nights) {
    const start = new Date(night.startedAt);
    if (Number.isNaN(start.getTime())) {
      loose.push(night);
      continue;
    }
    const year = start.getFullYear();
    const month = start.getMonth();
    const months = byYear.get(year) ?? new Map<number, ScoredSleepNight[]>();
    const grouped = months.get(month);
    if (grouped) grouped.push(night);
    else months.set(month, [night]);
    byYear.set(year, months);
  }
  const years = [...byYear.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([year, months]) => ({
      year,
      months: [...months.entries()]
        .sort((left, right) => right[0] - left[0])
        .map(([month, grouped]) => ({ month, nights: grouped })),
    }));
  return { years, loose };
}

function countLabel(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
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

function scoreColor(label: ScoredSleepNight['scoreLabel']): string {
  if (label === 'Excellent' || label === 'Good') return colors.ok;
  if (label === 'Fair') return '#f0c36a';
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
  body: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 22,
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  date: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  summaryValue: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
  group: {
    gap: 14,
  },
  monthHeader: {
    marginLeft: 12,
  },
  cycles: {
    gap: 10,
  },
  cycleLine: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  meta: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  stageLine: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
});
