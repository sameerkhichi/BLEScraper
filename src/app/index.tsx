import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { openRing } from '../ble/ringClient';
import {
  ActivityChart,
  formatTaken,
  HeartRateChart,
  latestNight,
  OxygenMeter,
  SleepNightSummary,
  StressPanel,
  Thermometer,
} from '../components/readings';
import { SideMenu } from '../components/sideMenu';
import { Button, Card, colors } from '../components/ui';
import { latestHeartRate, latestMetric, latestVital, stressSummary } from '../model';
import { pauseAutoSync } from '../sync/ringGate';
import { useAppState } from '../state/AppProvider';

const BEAT_POINTS = 40;

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

function plotNumbers<T extends { timestamp: string }>(samples: T[] | undefined, read: (sample: T) => number): number[] {
  return [...(samples ?? [])]
    .filter((sample) => Number.isFinite(Date.parse(sample.timestamp)) && Number.isFinite(read(sample)))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .map(read);
}

function MenuButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel="Open menu"
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={styles.menuButton}
    >
      <View style={styles.menuBar} />
      <View style={styles.menuBar} />
      <View style={styles.menuBar} />
    </Pressable>
  );
}

export default function HomeScreen() {
  const { busy, settings, lastPayload, scan, recordHeartRate, recordStress, withRing } = useAppState();
  const [menuOpen, setMenuOpen] = useState(false);
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
  const night = latestNight(lastPayload?.sleep ?? []);
  const dayStress = stressSummary(lastPayload?.stress ?? [], lastPayload?.sleep ?? []);
  const storedHeart = latestHeartRate(lastPayload);
  const oxygen = latestVital(lastPayload?.vitalSpots, 'spo2');
  const temperature = latestVital(lastPayload?.vitalSpots, 'bodyTemperatureC');
  const storedStress = latestMetric(lastPayload?.stress);
  const measuringHeart = heartPhase === 'live';
  const heartTaken = measuringHeart && heartAt != null ? new Date(heartAt).toISOString() : storedHeart?.timestamp ?? null;

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
      if (heartMounted.current) {
        setHeartPhase('idle');
        setBeats([]);
      }
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

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerLeft: () => <MenuButton onPress={() => setMenuOpen(true)} /> }} />
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        <Card style={styles.todayCard}>
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
            bpm={measuringHeart ? liveBpm : storedHeart?.bpm ?? null}
            live={measuringHeart}
            points={measuringHeart ? beats : plotNumbers(lastPayload?.heartRate, (sample) => sample.bpm)}
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
          <OxygenMeter spo2={oxygen?.value ?? null} />
          <TakenLine timestamp={oxygen?.timestamp ?? null} />
          <Button
            disabled={busy}
            label="Measure blood oxygen"
            onPress={() => requireRing(() => void scan('spo2'))}
            tone="secondary"
          />
        </Card>

        <Card>
          <Text style={styles.label}>Body temperature</Text>
          <Thermometer celsius={temperature?.value ?? null} />
          <TakenLine timestamp={temperature?.timestamp ?? null} />
          <Button
            disabled={busy}
            label="Measure body temperature"
            onPress={() => requireRing(() => void scan('temperature'))}
            tone="secondary"
          />
        </Card>

        <Card>
          <Text style={styles.label}>Stress</Text>
          <StressPanel
            live={stressPhase === 'measuring' ? liveStress : null}
            points={plotNumbers(lastPayload?.stress, (sample) => sample.value)}
            reading={storedStress}
            summary={dayStress}
          />
          <TakenLine timestamp={storedStress?.timestamp ?? null} />
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
      </ScrollView>
      <SideMenu onClose={() => setMenuOpen(false)} open={menuOpen} />
    </View>
  );
}

function TakenLine({ timestamp }: { timestamp: string | null }) {
  const label = formatTaken(timestamp);
  if (!label) return null;
  return <Text style={styles.meta}>{label}</Text>;
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
  todayCard: {
    gap: 4,
    padding: 10,
  },
  menuButton: {
    gap: 5,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  menuBar: {
    backgroundColor: colors.text,
    borderRadius: 1,
    height: 2,
    width: 22,
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
  warning: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
