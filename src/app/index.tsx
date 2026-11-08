import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { openRing } from '../ble/ringClient';
import { DebugLog } from '../components/debugLogView';
import {
  ActivityChart,
  formatDuration,
  formatTaken,
  HeartRateChart,
  latestNight,
  OxygenMeter,
  SleepNightSummary,
  Thermometer,
} from '../components/readings';
import { Button, Card, colors } from '../components/ui';
import type { UploadPayload, VitalSpot } from '../model';
import { LOW_BATTERY_PERCENT } from '../sync/batteryAlert';
import { pauseAutoSync } from '../sync/ringGate';
import { CATCHUP_HOURS, HISTORY_MINUTES, SLEEP_HOURS, VITALS_MINUTES } from '../sync/schedule';
import { useAppState } from '../state/AppProvider';

const BEAT_POINTS = 40;

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

function latestToday(samples: { timestamp: string }[]): string | null {
  const now = new Date();
  let latest: string | null = null;
  for (const sample of samples) {
    const date = new Date(sample.timestamp);
    if (Number.isNaN(date.getTime())) continue;
    if (
      date.getFullYear() !== now.getFullYear() ||
      date.getMonth() !== now.getMonth() ||
      date.getDate() !== now.getDate()
    ) {
      continue;
    }
    if (!latest || sample.timestamp > latest) latest = sample.timestamp;
  }
  return latest;
}

function latestSpot(spots: VitalSpot[] | undefined, field: 'spo2' | 'bodyTemperatureC'): string | null {
  let latest: string | null = null;
  for (const spot of spots ?? []) {
    if (typeof spot[field] !== 'number') continue;
    if (!latest || spot.timestamp > latest) latest = spot.timestamp;
  }
  return latest;
}

export default function HomeScreen() {
  const { busy, status, settings, queue, lastPayload, sync, scan, sendPending, forgetRing, recordHeartRate, withRing } =
    useAppState();
  const [heartPhase, setHeartPhase] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [liveBpm, setLiveBpm] = useState<number | null>(null);
  const [beats, setBeats] = useState<number[]>([]);
  const [heartAt, setHeartAt] = useState<number | null>(null);
  const [heartError, setHeartError] = useState<string | null>(null);
  const heartStop = useRef<(() => void) | null>(null);
  const heartMounted = useRef(true);
  const bpmRef = useRef<number | null>(null);
  const insets = useSafeAreaInsets();
  const waiting = queue.length > 0;
  const ringLabel = settings.ringName || settings.ringId || 'No ring selected';
  const apiLabel = settings.apiUrl.trim() || 'No API URL yet';
  const newestHeartRate = latestSample(lastPayload);
  const motion = lastPayload?.accelerometer;
  const night = latestNight(lastPayload?.sleep ?? []);
  const heartTaken =
    heartAt != null
      ? new Date(heartAt).toISOString()
      : lastPayload?.realtimeHeartRateAt ?? lastPayload?.heartRate.at(-1)?.timestamp ?? null;
  const oxygenTaken = typeof lastPayload?.spo2 === 'number' ? latestSpot(lastPayload.vitalSpots, 'spo2') : null;
  const temperatureTaken =
    typeof lastPayload?.bodyTemperatureC === 'number' ? latestSpot(lastPayload.vitalSpots, 'bodyTemperatureC') : null;

  const requireRing = (action: () => void) => {
    if (!settings.ringId) {
      router.push('/scan');
      return;
    }
    action();
  };

  useEffect(() => {
    heartMounted.current = true;
    return () => {
      heartMounted.current = false;
      heartStop.current?.();
    };
  }, []);

  const startHeart = async () => {
    if (!settings.ringId) {
      router.push('/scan');
      return;
    }
    const ringId = settings.ringId;
    setHeartError(null);
    setBeats([]);
    setLiveBpm(null);
    setHeartAt(null);
    setHeartPhase('connecting');
    bpmRef.current = null;
    const session = { cancel: false, stop: null as (() => void) | null };
    heartStop.current = () => {
      session.cancel = true;
      session.stop?.();
    };
    const resume = pauseAutoSync();
    try {
      await withRing(async () => {
        const client = await openRing(ringId);
        session.stop = () => client.stopHeartRate();
        if (session.cancel) return;
        if (heartMounted.current) setHeartPhase('live');
        await client.watchHeartRate((frame) => {
          if (!heartMounted.current) return;
          if (frame.kind !== 'bpm') return;
          bpmRef.current = frame.bpm;
          setLiveBpm(frame.bpm);
          setHeartAt(Date.now());
          setBeats((current) => [...current, frame.bpm].slice(-BEAT_POINTS));
        });
      });
    } catch (caught) {
      if (heartMounted.current && !session.cancel) {
        setHeartError(caught instanceof Error ? caught.message : 'The heart-rate monitor stopped.');
      }
    } finally {
      resume();
      heartStop.current = null;
      if (heartMounted.current) setHeartPhase('idle');
      const bpm = bpmRef.current;
      if (bpm !== null) void recordHeartRate(bpm);
    }
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
          <TakenLine timestamp={latestToday(lastPayload?.steps ?? [])} />
        </Card>

        <Card>
          <Text style={styles.label}>Heart rate</Text>
          <HeartRateChart
            bpm={heartPhase === 'idle' ? (liveBpm ?? lastPayload?.realtimeHeartRate ?? null) : liveBpm}
            live={heartPhase === 'live'}
            points={
              heartPhase === 'idle' && beats.length === 0
                ? (lastPayload?.heartRate ?? []).slice(-BEAT_POINTS).map((sample) => sample.bpm)
                : beats
            }
          />
          <TakenLine timestamp={heartTaken} />
          {heartError ? <Text style={styles.warning}>{heartError}</Text> : null}
          {heartPhase === 'connecting' ? <ActivityIndicator color={colors.accent} /> : null}
          {heartPhase === 'idle' ? (
            <Button disabled={busy} label="Measure heart rate" onPress={() => void startHeart()} tone="secondary" />
          ) : (
            <Button
              label={heartPhase === 'connecting' ? 'Cancel' : 'Stop'}
              onPress={() => heartStop.current?.()}
              tone="danger"
            />
          )}
        </Card>

        <Card>
          <Text style={styles.label}>Blood oxygen</Text>
          <OxygenMeter spo2={lastPayload?.spo2 ?? null} />
          <TakenLine timestamp={oxygenTaken} />
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
          <TakenLine timestamp={temperatureTaken} />
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
          <Text style={styles.meta}>Stored samples use UTC. Today follows the phone clock.</Text>
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
          <Button label="View waiting readings" onPress={() => router.push('/queue')} tone="secondary" />
          <Button label="API settings" onPress={() => router.push('/settings')} tone="secondary" />
        </Card>

        <Button disabled={busy} label="Sync ring" onPress={syncRing} />

        <Card>
          <Text style={styles.label}>Notes</Text>
          <View style={styles.notes}>
            {settings.autoSync ? (
              <>
                <Text style={styles.body}>
                  Leave BLEScraper in the app switcher. The screen can be off, and another app can be in front.
                </Text>
                <Text style={styles.body}>
                  Steps and stored heart rate are read every {HISTORY_MINUTES} minutes while BLEScraper is on screen. Live heart rate, SpO2, and temperature run every {VITALS_MINUTES} minutes. Sleep is read about every {SLEEP_HOURS} hours. Each check connects, reads, and disconnects.
                </Text>
                <Text style={styles.body}>
                  With the screen off or another app in front, that timer pauses. Opening BLEScraper runs a check when one is due. About every {CATCHUP_HOURS} hours the phone wakes on its own, downloads the stored record, and if the ring is being worn takes one blood-oxygen and temperature reading. Then it sends and disconnects. Sleep is included. A ring battery below {LOW_BATTERY_PERCENT}% notifies you from these checks.
                </Text>
                <Text style={styles.body}>
                  A notification appears when that wake starts, separate from opening the app. iOS chooses the wake time and will not wake the app after you swipe it away. Android also shows a notification while a download is running.
                </Text>
              </>
            ) : (
              <Text style={styles.body}>
                Automatic download is off. Turn it on in API settings. With it on, leave BLEScraper in the app switcher. Checks every {HISTORY_MINUTES} minutes run while the app is on screen. With the screen off or another app in front, the phone wakes about every {CATCHUP_HOURS} hours.
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

function TakenLine({ timestamp }: { timestamp: string | null }) {
  const label = formatTaken(timestamp);
  if (!label) return null;
  return <Text style={styles.meta}>{label}</Text>;
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
