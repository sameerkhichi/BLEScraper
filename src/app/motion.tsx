import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { RingClient } from '../ble/ringClient';
import type { RawSensorFrame } from '../ble/protocol';
import { Button, Card, colors } from '../components/ui';
import type { AccelSample } from '../model';
import { useAppState } from '../state/AppProvider';

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function magnitude(sample: { x: number; y: number; z: number }): number {
  return Math.sqrt(sample.x * sample.x + sample.y * sample.y + sample.z * sample.z);
}

export default function MotionScreen() {
  const { busy, settings, recordMotion, withRing } = useAppState();
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [sample, setSample] = useState<AccelSample | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [ppg, setPpg] = useState<number | null>(null);
  const [optical, setOptical] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopRef.current?.();
    };
  }, []);

  const start = async () => {
    if (!settings.ringId) {
      router.push('/scan');
      return;
    }
    const ringId = settings.ringId;
    setError(null);
    setPhase('connecting');
    const session = { cancel: false, client: null as RingClient | null };
    stopRef.current = () => {
      session.cancel = true;
      session.client?.stopMotion();
    };

    try {
      await withRing(async () => {
        let client: RingClient | null = null;
        try {
          client = await RingClient.connect(ringId);
          session.client = client;
          if (session.cancel) return;
          if (mounted.current) setPhase('live');
          await client.watchMotion((frame) => {
            if (!mounted.current) return;
            applyFrame(frame, setSample, setHistory, setPpg, setOptical);
          });
        } finally {
          session.client = null;
          if (client) await client.disconnect();
        }
      });
    } catch (caught) {
      if (mounted.current && !session.cancel) {
        setError(caught instanceof Error ? caught.message : 'The accelerometer stream stopped.');
      }
    } finally {
      stopRef.current = null;
      if (mounted.current) setPhase('idle');
    }
  };

  const live = phase !== 'idle';

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.body}>
        X runs along the finger, Y around the band, and Z through the ring. At rest the total stays near 1 g.
        Move the ring and the dot and bars follow. PPG and optical counts update from the same stream.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Card>
        <Level sample={sample} />
        <Text style={styles.magnitude}>{sample ? `${magnitude(sample).toFixed(2)} g` : '—'}</Text>
        <AxisBar label="X" value={sample?.x ?? null} />
        <AxisBar label="Y" value={sample?.y ?? null} />
        <AxisBar label="Z" value={sample?.z ?? null} />
        <Sparkline values={history} />
        <Text style={styles.meta}>
          PPG {ppg ?? '—'} · Optical {optical ?? '—'}
        </Text>
        {phase === 'connecting' ? <ActivityIndicator color={colors.accent} /> : null}
        {phase === 'live' && !sample ? <Text style={styles.meta}>Waiting for the first sample.</Text> : null}
      </Card>
      {live ? (
        <Button label={phase === 'connecting' ? 'Cancel' : 'Stop'} onPress={() => stopRef.current?.()} tone="danger" />
      ) : (
        <Button disabled={busy} label="Start accelerometer" onPress={() => void start()} />
      )}
      <Button
        disabled={!sample}
        label="Send latest sample"
        onPress={() => {
          if (sample) void recordMotion(sample);
        }}
        tone="secondary"
      />
    </ScrollView>
  );
}

function applyFrame(
  frame: RawSensorFrame,
  setSample: (sample: AccelSample) => void,
  setHistory: (update: (current: number[]) => number[]) => void,
  setPpg: (value: number) => void,
  setOptical: (value: number) => void,
): void {
  if (frame.kind === 'accelerometer') {
    const next: AccelSample = {
      x: round3(frame.reading.x),
      y: round3(frame.reading.y),
      z: round3(frame.reading.z),
      sampledAt: new Date().toISOString(),
    };
    setSample(next);
    setHistory((current) => [...current, magnitude(next)].slice(-36));
    return;
  }
  if (frame.kind === 'ppg') setPpg(frame.value);
  if (frame.kind === 'optical') setOptical(frame.value);
}

function Level({ sample }: { sample: AccelSample | null }) {
  const x = Math.max(-1, Math.min(1, sample?.x ?? 0));
  const y = Math.max(-1, Math.min(1, sample?.y ?? 0));
  return (
    <View style={styles.pad}>
      <View style={styles.crosshairH} />
      <View style={styles.crosshairV} />
      {sample ? (
        <View style={[styles.dot, { left: `${50 + x * 42}%`, top: `${50 - y * 42}%` }]} />
      ) : (
        <Text style={styles.padHint}>Start to see tilt</Text>
      )}
    </View>
  );
}

function AxisBar({ label, value }: { label: string; value: number | null }) {
  const shown = value ?? 0;
  const clamped = Math.max(-2, Math.min(2, shown));
  const width = (Math.abs(clamped) / 2) * 50;
  const positive = clamped >= 0;
  return (
    <View style={styles.axis}>
      <View style={styles.axisHead}>
        <Text style={styles.axisLabel}>{label}</Text>
        <Text style={styles.axisValue}>{value === null ? '—' : shown.toFixed(2)}</Text>
      </View>
      <View style={styles.track}>
        {value !== null ? (
          <View
            style={[
              styles.bar,
              positive ? { left: '50%', width: `${width}%` } : { right: '50%', width: `${width}%` },
            ]}
          />
        ) : null}
        <View style={styles.zero} />
      </View>
    </View>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) {
    return <Text style={styles.meta}>Magnitude fills in as samples arrive.</Text>;
  }
  return (
    <View style={styles.spark}>
      {values.map((value, index) => (
        <View
          key={`${index}-${value.toFixed(3)}`}
          style={[styles.sparkBar, { height: 4 + (Math.min(value, 2) / 2) * 32 }]}
        />
      ))}
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
  meta: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  magnitude: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
  pad: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderRadius: 16,
    borderWidth: 1,
    height: 180,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 180,
  },
  padHint: {
    color: colors.muted,
    fontSize: 13,
  },
  crosshairH: {
    backgroundColor: colors.line,
    height: 1,
    left: 16,
    position: 'absolute',
    right: 16,
  },
  crosshairV: {
    backgroundColor: colors.line,
    bottom: 16,
    position: 'absolute',
    top: 16,
    width: 1,
  },
  dot: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    height: 20,
    marginLeft: -10,
    marginTop: -10,
    position: 'absolute',
    width: 20,
  },
  axis: {
    gap: 4,
  },
  axisHead: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  axisLabel: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
  },
  axisValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  track: {
    backgroundColor: colors.bg,
    borderRadius: 6,
    height: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  bar: {
    backgroundColor: colors.accent,
    bottom: 0,
    position: 'absolute',
    top: 0,
  },
  zero: {
    backgroundColor: colors.muted,
    bottom: 0,
    left: '50%',
    position: 'absolute',
    top: 0,
    width: 1,
  },
  spark: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 2,
    height: 40,
  },
  sparkBar: {
    backgroundColor: colors.accent,
    borderRadius: 2,
    flex: 1,
  },
});
