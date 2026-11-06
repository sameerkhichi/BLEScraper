import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, colors } from '../components/ui';
import type { SleepNight, SleepStageName } from '../model';
import { useAppState } from '../state/AppProvider';

const stageColor: Record<SleepStageName, string> = {
  light: '#7fbf8a',
  deep: colors.accent,
  rem: '#f0c36a',
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

const stageLabel: Record<SleepStageName, string> = {
  light: 'Light',
  deep: 'Deep',
  rem: 'REM',
  awake: 'Awake',
  unknown: 'Unknown',
};

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

function formatClock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

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
      <Text style={styles.label}>{night.daysAgo === 0 ? 'Last night' : `${night.daysAgo} days ago`}</Text>
      <Text style={styles.range}>
        {formatClock(night.startedAt)} – {formatClock(night.endedAt)}
      </Text>
      <View style={styles.metrics}>
        <Metric label="Asleep" value={formatMinutes(night.minutesAsleep)} />
        <Metric label="In bed" value={formatMinutes(night.minutesInBed)} />
        <Metric label="Deep" value={formatMinutes(night.minutesDeep)} />
        <Metric label="REM" value={formatMinutes(night.minutesRem)} />
        <Metric label="Light" value={formatMinutes(night.minutesLight)} />
        <Metric label="Awake" value={formatMinutes(night.minutesAwake)} />
      </View>
      <Text style={styles.meta}>
        {night.awakenings} awakening{night.awakenings === 1 ? '' : 's'} · {night.cycles.length} cycle
        {night.cycles.length === 1 ? '' : 's'}
      </Text>

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
        {(['deep', 'light', 'rem', 'awake'] as SleepStageName[]).map((stage) => (
          <View key={stage} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: stageColor[stage] }]} />
            <Text style={styles.meta}>{stageLabel[stage]}</Text>
          </View>
        ))}
      </View>

      {night.cycles.map((cycle) => (
        <Text key={cycle.index} style={styles.meta}>
          Cycle {cycle.index} · {formatClock(cycle.startedAt)} – {formatClock(cycle.endedAt)} · {formatMinutes(cycle.minutes)}
          {cycle.complete ? '' : ' · no REM'}
        </Text>
      ))}

      {night.stages.map((stage, index) => (
        <Text key={`${stage.stage}-${stage.startedAt}-${index}`} style={styles.stageLine}>
          {formatClock(stage.startedAt)} · {stageLabel[stage.stage]} · {formatMinutes(stage.minutes)}
        </Text>
      ))}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
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
  range: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
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
  metrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metric: {
    flexGrow: 1,
    gap: 2,
    minWidth: '28%',
  },
  metricValue: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  hypnogram: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 2,
    height: 64,
    marginTop: 8,
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
