import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, colors } from '../components/ui';
import { useAppState } from '../state/AppProvider';

function totalSteps(payload: { steps: { steps: number }[] } | null): number {
  if (!payload) return 0;
  return payload.steps.reduce((sum, sample) => sum + sample.steps, 0);
}

export default function HomeScreen() {
  const { busy, status, settings, queue, lastPayload, sync, measure, sendPending } = useAppState();
  const ringLabel = settings.ringName || settings.ringId || 'No ring selected';
  const apiLabel = settings.apiUrl.trim() || 'No API URL yet';

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.kicker}>Colmi R09</Text>
      <Text style={styles.title}>Pull the ring, then hand the reading to the Arduino.</Text>

      <Card>
        <Text style={styles.label}>Status</Text>
        <Text selectable style={styles.body}>
          {status}
        </Text>
        {busy ? <ActivityIndicator color={colors.accent} /> : null}
      </Card>

      <Card>
        <Text style={styles.label}>Ring</Text>
        <Text style={styles.body}>{ringLabel}</Text>
        <Text style={styles.meta}>
          {lastPayload?.battery
            ? `Battery ${lastPayload.battery.level}%${lastPayload.battery.charging ? ', charging' : ''}`
            : 'Battery shows up after a sync.'}
        </Text>
        <Button label="Choose ring" onPress={() => router.push('/scan')} tone="secondary" />
      </Card>

      <Card>
        <Text style={styles.label}>Arduino</Text>
        <Text selectable style={styles.body}>
          {apiLabel}
        </Text>
        <Text style={styles.meta}>
          {queue.length === 0 ? 'Nothing waiting to send.' : `${queue.length} reading${queue.length === 1 ? '' : 's'} waiting.`}
        </Text>
        <Button label="API settings" onPress={() => router.push('/settings')} tone="secondary" />
      </Card>

      <Card>
        <Text style={styles.label}>Last reading</Text>
        <View style={styles.metrics}>
          <Metric label="Live HR" value={lastPayload?.realtimeHeartRate ? `${lastPayload.realtimeHeartRate}` : '—'} />
          <Metric label="HR samples" value={`${lastPayload?.heartRate.length ?? 0}`} />
          <Metric label="Steps" value={`${totalSteps(lastPayload)}`} />
        </View>
        <Text style={styles.meta}>
          {lastPayload ? `Synced ${new Date(lastPayload.syncedAt).toLocaleString()}` : 'No sync yet.'}
        </Text>
        <Text style={styles.meta}>Clock and history use UTC.</Text>
      </Card>

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
      <Button
        disabled={busy}
        label="Measure heart rate"
        onPress={() => {
          if (!settings.ringId) {
            router.push('/scan');
            return;
          }
          void measure();
        }}
        tone="secondary"
      />
      <Button disabled={busy || queue.length === 0} label="Send waiting readings" onPress={() => void sendPending()} tone="secondary" />
    </ScrollView>
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
  kicker: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
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
  metrics: {
    flexDirection: 'row',
    gap: 12,
  },
  metric: {
    flex: 1,
    gap: 2,
  },
  metricValue: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
});
