import { router } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getDebugLines, subscribeDebugLog } from '../ble/debugLog';
import {
  ActivityChart,
  formatDuration,
  HeartRateChart,
  latestNight,
  OxygenMeter,
  SleepNightSummary,
  Thermometer,
} from '../components/readings';
import { Button, Card, colors } from '../components/ui';
import type { UploadPayload } from '../model';
import { useAppState } from '../state/AppProvider';

function totalSteps(payload: { steps: { steps: number }[] } | null): number {
  if (!payload) return 0;
  return payload.steps.reduce((sum, sample) => sum + sample.steps, 0);
}

function latestSample(payload: UploadPayload | null): string | null {
  const sample = payload?.heartRate.at(-1);
  if (!sample) return null;
  return `${sample.bpm} bpm at ${new Date(sample.timestamp).toLocaleString()}`;
}

function formatReading(value: number | null | undefined, suffix = ''): string {
  return typeof value === 'number' ? `${value}${suffix}` : '—';
}

export default function HomeScreen() {
  const { busy, status, settings, queue, lastPayload, sync, scan, sendPending, forgetRing } = useAppState();
  const debugLines = useSyncExternalStore(subscribeDebugLog, getDebugLines);
  const insets = useSafeAreaInsets();
  const waiting = queue.length > 0;
  const ringLabel = settings.ringName || settings.ringId || 'No ring selected';
  const apiLabel = settings.apiUrl.trim() || 'No API URL yet';
  const newestHeartRate = latestSample(lastPayload);
  const motion = lastPayload?.accelerometer;
  const night = latestNight(lastPayload?.sleep ?? []);

  const requireRing = (action: () => void) => {
    if (!settings.ringId) {
      router.push('/scan');
      return;
    }
    action();
  };

  const syncRing = () => {
    if (!settings.ringId) {
      router.push('/scan');
      return;
    }
    void sync();
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, waiting ? { paddingBottom: 96 + insets.bottom } : null]}
        style={styles.screen}
      >
        <Card>
          <ActivityChart steps={lastPayload?.steps ?? []} />
        </Card>

        <Card>
          <Text style={styles.label}>Heart rate</Text>
          <HeartRateChart bpm={lastPayload?.realtimeHeartRate ?? null} samples={lastPayload?.heartRate ?? []} />
          <Button
            disabled={busy}
            label="Measure heart rate"
            onPress={() => requireRing(() => void scan('heart-rate'))}
            tone="secondary"
          />
        </Card>

        <Card>
          <Text style={styles.label}>Blood oxygen</Text>
          <OxygenMeter spo2={lastPayload?.spo2 ?? null} />
          <Button
            disabled={busy}
            label="Measure blood oxygen"
            onPress={() => requireRing(() => void scan('spo2'))}
            tone="secondary"
          />
        </Card>

        <Card>
          <Text style={styles.label}>Body temperature</Text>
          <Thermometer celsius={lastPayload?.bodyTemperatureC ?? null} />
          <Button
            disabled={busy}
            label="Measure body temperature"
            onPress={() => requireRing(() => void scan('temperature'))}
            tone="secondary"
          />
        </Card>

        <Button disabled={busy} label="Scan all sensors" onPress={() => requireRing(() => void scan('all'))} />

        <Card>
          <Text style={styles.label}>Sleep</Text>
          {night ? (
            <SleepNightSummary night={night} />
          ) : (
            <Text style={styles.meta}>No night stored yet. Sync while the ring is nearby.</Text>
          )}
          <Button label="Sleep history" onPress={() => router.push('/sleep')} tone="secondary" />
        </Card>

        <Button
          disabled={busy}
          label="Accelerometer"
          onPress={() => requireRing(() => router.push('/motion'))}
          tone="secondary"
        />

        <Card>
          <Text style={styles.label}>Last reading</Text>
          <View style={styles.metrics}>
            <Metric label="Heart rate" value={formatReading(lastPayload?.realtimeHeartRate)} />
            <Metric label="SpO2" value={formatReading(lastPayload?.spo2, '%')} />
            <Metric
              label="Temp"
              value={typeof lastPayload?.bodyTemperatureC === 'number' ? `${lastPayload.bodyTemperatureC.toFixed(1)}°` : '—'}
            />
            <Metric label="HR samples" value={`${lastPayload?.heartRate.length ?? 0}`} />
            <Metric label="Steps" value={`${totalSteps(lastPayload)}`} />
            <Metric label="Asleep" value={night ? formatDuration(night.minutesAsleep) : '—'} />
          </View>
          {motion ? (
            <Text style={styles.meta}>
              Accelerometer {motion.x.toFixed(2)} x, {motion.y.toFixed(2)} y, {motion.z.toFixed(2)} z g
            </Text>
          ) : null}
          {newestHeartRate ? <Text style={styles.meta}>Newest stored heart rate {newestHeartRate}</Text> : null}
          {night ? (
            <Text style={styles.meta}>
              {`Latest sleep ${formatDuration(night.minutesAsleep)}, ${night.cycles.length} cycle${night.cycles.length === 1 ? '' : 's'}`}
            </Text>
          ) : null}
          {lastPayload?.warnings.map((warning) => (
            <Text key={warning} style={styles.warning}>
              {warning}
            </Text>
          ))}
          <Text style={styles.meta}>
            {lastPayload ? `Updated ${new Date(lastPayload.syncedAt).toLocaleString()}` : 'No reading yet.'}
          </Text>
          <Text style={styles.meta}>Clock and history use UTC.</Text>
        </Card>

        <Card>
          <Text style={styles.label}>Ring</Text>
          <Text style={styles.body}>{ringLabel}</Text>
          {settings.ringId ? (
            <Text selectable style={styles.meta}>
              {settings.ringId}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            {lastPayload?.battery
              ? `Battery ${lastPayload.battery.level}%${lastPayload.battery.charging ? ', charging' : ''}`
              : 'Battery shows up after a sync.'}
          </Text>
          <Button label="Choose ring" onPress={() => router.push('/scan')} tone="secondary" />
          {settings.ringId ? (
            <Button label="Disconnect ring" onPress={() => void forgetRing()} tone="danger" />
          ) : null}
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

        <Button disabled={busy} label="Sync ring" onPress={syncRing} />
        {settings.autoSync ? null : (
          <Text style={styles.meta}>Automatic sync is off. Turn it on in Settings.</Text>
        )}

        <Card>
          <Text style={styles.label}>Status</Text>
          <Text selectable style={styles.body}>
            {status}
          </Text>
          {busy ? <ActivityIndicator color={colors.accent} /> : null}
        </Card>

        <Card>
          <Text style={styles.label}>Debug</Text>
          {debugLines.length === 0 ? (
            <Text style={styles.meta}>Scan or sync to fill this log. It clears when the app closes.</Text>
          ) : (
            debugLines.slice(0, 12).map((line, index) => (
              <Text key={`${index}-${line}`} selectable style={styles.debug}>
                {line}
              </Text>
            ))
          )}
        </Card>

        {waiting ? null : (
          <Button disabled label="Send waiting readings" onPress={() => void sendPending()} tone="secondary" />
        )}
      </ScrollView>

      {waiting ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Button disabled={busy} label="Send waiting readings" onPress={() => void sendPending()} tone="secondary" />
        </View>
      ) : null}
    </View>
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
  footer: {
    backgroundColor: colors.bg,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    position: 'absolute',
    right: 0,
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
  warning: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  debug: {
    color: colors.muted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 17,
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
});
