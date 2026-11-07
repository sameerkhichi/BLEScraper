import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { formatClock, formatDuration, SleepNightSummary, stageLabel } from '../components/readings';
import { Button, Card, colors } from '../components/ui';
import type { SleepNight } from '../model';
import { useAppState } from '../state/AppProvider';

export default function SleepScreen() {
  const { busy, settings, lastPayload, sync } = useAppState();
  const nights = lastPayload?.sleep ?? [];

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

      {nights.length === 0 ? (
        <Card>
          <Text style={styles.label}>No sleep yet</Text>
          <Text style={styles.meta}>Sync while the ring is nearby. It only keeps a few nights.</Text>
        </Card>
      ) : (
        nights.map((night) => <NightCard key={`${night.daysAgo}-${night.startedAt}`} night={night} />)
      )}
    </ScrollView>
  );
}

function NightCard({ night }: { night: SleepNight }) {
  return (
    <Card>
      <SleepNightSummary night={night} />
      <Text style={styles.meta}>
        {`In bed ${formatDuration(night.minutesInBed)} · ${night.awakenings} awakening${night.awakenings === 1 ? '' : 's'} · ${night.cycles.length} cycle${night.cycles.length === 1 ? '' : 's'}`}
      </Text>

      {night.cycles.map((cycle) => (
        <Text key={cycle.index} style={styles.meta}>
          {`Cycle ${cycle.index} · ${formatClock(cycle.startedAt)} – ${formatClock(cycle.endedAt)} · ${formatDuration(cycle.minutes)}${cycle.complete ? '' : ' · no REM'}`}
        </Text>
      ))}

      {night.stages.map((stage, index) => (
        <Text key={`${stage.stage}-${stage.startedAt}-${index}`} style={styles.stageLine}>
          {formatClock(stage.startedAt)} · {stageLabel[stage.stage]} · {formatDuration(stage.minutes)}
        </Text>
      ))}
    </Card>
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
