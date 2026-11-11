import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRingServices } from '../ble/ringServices';
import { useBackgroundWake } from '../sync/wakeLog';
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
  StressPanel,
  Thermometer,
} from '../components/readings';
import { Button, Card, colors } from '../components/ui';
import { stressSummary, type UploadPayload, type VitalSpot } from '../model';
import { LOW_BATTERY_PERCENT } from '../sync/batteryAlert';
import { FEVER_C, MILD_HYPOTHERMIA_C } from '../sync/temperatureAlert';
import { pauseAutoSync } from '../sync/ringGate';
import { CATCHUP_HOURS } from '../sync/schedule';
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
  const ringServices = useRingServices();
  const lastWake = useBackgroundWake();
  const { busy, status, settings, queue, lastPayload, sync, scan, sendPending, forgetRing, recordHeartRate, recordStress, withRing } =
    useAppState();
  const [heartPhase, setHeartPhase] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [liveBpm, setLiveBpm] = useState<number | null>(null);
  const [beats, setBeats] = useState<number[]>([]);
  const [heartAt, setHeartAt] = useState<number | null>(null);
  const [heartError, setHeartError] = useState<string | null>(null);
  const [stressPhase, setStressPhase] = useState<'idle' | 'measuring'>('idle');
  const [liveStress, setLiveStress] = useState<number | null>(null);
  const [stressError, setStressError] = useState<string | null>(null);
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
  const dayStress = stressSummary(lastPayload?.stress ?? [], lastPayload?.sleep ?? []);
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

  const measureStressReading = async () => {
    if (!settings.ringId) {
      router.push('/scan');
      return;
    }
    const ringId = settings.ringId;
    setStressError(null);
    setLiveStress(null);
    setStressPhase('measuring');
    const resume = pauseAutoSync();
    try {
      const value = await withRing(async () => {
        const client = await openRing(ringId);
        return client.measureStress();
      });
      if (value === null) {
        setStressError('The ring did not return a stress reading.');
        return;
      }
      setLiveStress(value);
      await recordStress(value);
    } catch (caught) {
      setStressError(caught instanceof Error ? caught.message : 'The stress reading stopped.');
    } finally {
      resume();
      setStressPhase('idle');
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
          <ActivityChart
            sleep={lastPayload?.sleep ?? []}
            steps={lastPayload?.steps ?? []}
            stress={lastPayload?.stress ?? []}
          />
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
          <Text style={styles.label}>Stress</Text>
          <StressPanel live={stressPhase === 'measuring' ? liveStress : null} summary={dayStress} />
          <TakenLine timestamp={dayStress.current?.timestamp ?? null} />
          {stressError ? <Text style={styles.warning}>{stressError}</Text> : null}
          {stressPhase === 'measuring' ? <ActivityIndicator color={colors.accent} /> : null}
          <Button
            disabled={busy || stressPhase === 'measuring'}
            label="Measure stress"
            onPress={() => void measureStressReading()}
            tone="secondary"
          />
          <Button label="Stress history" onPress={() => router.push('/stress')} tone="secondary" />
        </Card>

        <Card>
          <Text style={styles.label}>Sleep</Text>
          {night ? (
            <SleepNightSummary night={night} nights={lastPayload?.sleep ?? []} />
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
          {ringServices.length > 0 ? (
            <Text selectable style={styles.services}>
              {ringServices.join('\n')}
            </Text>
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
                  The ring keeps its own heart-rate interval and the blood oxygen, stress, and HRV switches. Settings at the top right reads them from the ring. A download does not write them again. BLEScraper does not take those readings on its own.
                </Text>
                <Text style={styles.body}>
                  About every {CATCHUP_HOURS} hours the phone wakes, downloads the stored record, sends it, and disconnects. Opening BLEScraper runs that download when one is due. Leaving the app open does not start extra sensor checks. Sleep is included. A ring battery below {LOW_BATTERY_PERCENT}% notifies you from these checks. Body temperature notifies at {FEVER_C}°C or higher, and below {MILD_HYPOTHERMIA_C}°C.
                </Text>
                <Text style={styles.body}>
                  A notification appears when that wake starts and when it finishes. Opening the app is not required for the next one. iOS chooses the time and will not wake the app after you swipe it away. The download does not wait for Wi-Fi.
                </Text>
                <Text style={styles.body}>
                  {lastWake
                    ? `Last background wake ${new Date(lastWake.startedAt).toLocaleString()}. ${lastWake.note}`
                    : 'No background wake yet.'}
                </Text>
              </>
            ) : (
              <Text style={styles.body}>
                Automatic download is off. Turn it on in Settings at the top right. With it on, leave BLEScraper in the app switcher. The phone wakes about every {CATCHUP_HOURS} hours to download what the ring has stored.
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
  services: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 15,
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
