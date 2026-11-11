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
        scored.map((night) => (
          <NightCard key={`${night.daysAgo}-${night.startedAt}`} night={night} showDebt={night.startedAt === newestStart} />
        ))
      )}
    </ScrollView>
  );
}

function NightCard({ night, showDebt }: { night: ScoredSleepNight; showDebt: boolean }) {
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
