import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DebugLog } from '../components/debugLogView';
import { formatDuration, latestNight } from '../components/readings';
import { Card, colors } from '../components/ui';
import { latestHeartRate, latestVital, type UploadPayload } from '../model';
import { LOW_BATTERY_PERCENT } from '../sync/batteryAlert';
import { CATCHUP_HOURS } from '../sync/schedule';
import { FEVER_C, MILD_HYPOTHERMIA_C } from '../sync/temperatureAlert';
import { useBackgroundWake } from '../sync/wakeLog';
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

export default function DebugScreen() {
  const lastWake = useBackgroundWake();
  const { busy, status, settings, lastPayload } = useAppState();
  const newestHeartRate = latestSample(lastPayload);
  const motion = lastPayload?.accelerometer;
  const night = latestNight(lastPayload?.sleep ?? []);
  const storedHeart = latestHeartRate(lastPayload);
  const oxygen = latestVital(lastPayload?.vitalSpots, 'spo2');
  const temperature = latestVital(lastPayload?.vitalSpots, 'bodyTemperatureC');

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Card>
        <Text style={styles.label}>Last reading</Text>
        <View style={styles.metrics}>
          <Metric label="Heart rate" value={formatReading(storedHeart?.bpm)} />
          <Metric label="SpO2" value={formatReading(oxygen?.value, '%')} />
          <Metric
            label="Temp"
            value={typeof temperature?.value === 'number' ? `${temperature.value.toFixed(1)}°` : '—'}
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
        <Text style={styles.meta}>Stored samples use UTC. Today follows the phone clock.</Text>
      </Card>

      <Card>
        <Text style={styles.label}>Notes</Text>
        <View style={styles.notes}>
          {settings.autoSync ? (
            <>
              <Text style={styles.body}>
                Leave BLEScraper in the app switcher. The screen can be off, and another app can be in front.
              </Text>
              <Text style={styles.body}>
                The ring keeps its own heart-rate interval and the blood oxygen, stress, and HRV switches. Settings at the top right reads them from the ring. A download does not write them again. BLEScraper does not take those readings on its own.
              </Text>
              <Text style={styles.body}>
                The iPhone checks for ring data when iOS allows background activity. That depends on scheduling, settings, battery, and how the phone is used. Opening BLEScraper downloads when {CATCHUP_HOURS} hours have passed. Leaving the app open does not start extra sensor checks. Sleep is included. A ring battery below {LOW_BATTERY_PERCENT}% notifies you from these checks. Body temperature notifies at {FEVER_C}°C or higher, and below {MILD_HYPOTHERMIA_C}°C.
              </Text>
              <Text style={styles.body}>
                A notification appears when a wake starts and when it finishes. A wake sends waiting readings first. Leaving BLEScraper in the switcher does not promise a wake, and swiping it away can stop the next one until you open it again. The download does not wait for Wi-Fi.
              </Text>
              <Text style={styles.body}>
                {lastWake
                  ? `Last background wake ${new Date(lastWake.startedAt).toLocaleString()}. ${lastWake.note}`
                  : 'No background wake yet.'}
              </Text>
            </>
          ) : (
            <Text style={styles.body}>
              Automatic download is off. Turn it on in Settings at the top right. With it on, the iPhone checks for ring data when iOS allows background activity. Opening the app downloads when {CATCHUP_HOURS} hours have passed.
            </Text>
          )}
        </View>
      </Card>

      <Card>
        <Text style={styles.label}>Status</Text>
        <Text selectable style={styles.body}>
          {status}
        </Text>
        {busy ? <ActivityIndicator color={colors.accent} /> : null}
      </Card>

      <Card>
        <Text style={styles.label}>Debug</Text>
        <DebugLog empty="Scan or sync to fill this log. Earlier lines stay on this phone." />
      </Card>
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
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  notes: {
    gap: 10,
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
