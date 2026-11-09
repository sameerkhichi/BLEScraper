import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { openRing } from '../ble/ringClient';
import {
  HAND_GESTURES,
  RING_GESTURES,
  recognizeHandGestures,
  recognizeRingGesture,
  ringTilt,
  type HandGesture,
  type RawSensorFrame,
  type RingGesture,
} from '../ble/protocol';
import { Button, Card, colors } from '../components/ui';
import type { AccelReading, AccelSample } from '../model';
import { pauseAutoSync } from '../sync/ringGate';
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
  const [gesture, setGesture] = useState<RingGesture | null>(null);
  const [hands, setHands] = useState<HandGesture[]>([]);
  const stopRef = useRef<(() => void) | null>(null);
  const previousAccel = useRef<AccelSample | null>(null);
  const accelWindow = useRef<AccelReading[]>([]);
  const handUntil = useRef(new Map<HandGesture, number>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const resume = pauseAutoSync();
    return () => {
      mounted.current = false;
      stopRef.current?.();
      resume();
    };
  }, []);

  const start = async () => {
    if (!settings.ringId) {
      router.push('/scan');
      return;
    }
    const ringId = settings.ringId;
    setError(null);
    setGesture(null);
    setHands([]);
    previousAccel.current = null;
    accelWindow.current = [];
    handUntil.current.clear();
    setPhase('connecting');
    const session = { cancel: false, stop: null as (() => void) | null };
    stopRef.current = () => {
      session.cancel = true;
      session.stop?.();
    };

    try {
      await withRing(async () => {
        const client = await openRing(ringId);
        session.stop = () => client.stopMotion();
        if (session.cancel) return;
        if (mounted.current) setPhase('live');
        await client.watchMotion((frame) => {
          if (!mounted.current) return;
          if (frame.kind === 'wave') {
            noteHand('wave', handUntil.current);
            setHands(activeHands(handUntil.current));
            return;
          }
          if (frame.kind === 'accelerometer') {
            const next = toSample(frame.reading);
            const window = accelWindow.current;
            window.push(next);
            if (window.length > 8) window.shift();
            for (const hand of recognizeHandGestures(window)) noteHand(hand, handUntil.current);
            setHands(activeHands(handUntil.current));
            setGesture(recognizeRingGesture(next, previousAccel.current));
            previousAccel.current = next;
          }
          applyFrame(frame, setSample, setHistory, setPpg, setOptical);
        });
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
    <View style={styles.screen}>
    <ScrollView contentContainerStyle={styles.content} style={styles.scroll}>
      <Text style={styles.body}>
        The circle is the ring, fingertip at the top. The dot rolls toward whichever side you lower. Wave the hand,
        curl the finger in twice for come here, hold the right or left side up for a thumb, or trace a V with the
        fingertip for peace. Those poses are recognized on the phone. The ring's own wave stays as set in Settings.
        The pose chips stay too. The red and green lights turn off when you stop.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Card>
        <Level sample={sample} />
        <Text style={styles.meta}>The dot rolls toward the low side. Top of the circle is the fingertip.</Text>
        <Text style={styles.magnitude}>{sample ? `${magnitude(sample).toFixed(2)} g total` : '—'}</Text>
        <Text style={styles.meta}>About 1 g while the ring is still. That is gravity, already included.</Text>
        <AxisBar
          label="Along the finger"
          detail={sample ? tiltWords(ringTilt(sample).alongDeg, 'fingertip up', 'fingertip down') : 'X'}
          value={sample?.x ?? null}
        />
        <AxisBar
          label="Across the finger"
          detail={sample ? tiltWords(ringTilt(sample).acrossDeg, 'right side up', 'right side down') : 'Y'}
          value={sample?.y ?? null}
        />
        <AxisBar label="Through the ring" detail={sample ? faceWords(sample.z) : 'Z'} value={sample?.z ?? null} />
        <Text style={styles.axisLabel}>Shake</Text>
        <Sparkline values={history} />
        <Text style={styles.meta}>Each bar is one sample. A still ring stays short. Shaking it makes a tall bar.</Text>
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
    <View style={styles.gestureBar}>
      <View style={styles.gestureRow}>
        {[...HAND_GESTURES, ...RING_GESTURES].map((item) => {
          const lit = hands.includes(item.id as HandGesture) || gesture === item.id;
          return (
            <View key={item.id} style={[styles.chip, lit && styles.chipLit]}>
              <Text style={[styles.chipLabel, lit && styles.chipLabelLit]}>{item.label}</Text>
            </View>
          );
        })}
      </View>
    </View>
    </View>
  );
}

const HAND_HOLD_MS = 3000;

function noteHand(hand: HandGesture, until: Map<HandGesture, number>): void {
  until.set(hand, Date.now() + HAND_HOLD_MS);
}

function activeHands(until: Map<HandGesture, number>): HandGesture[] {
  const now = Date.now();
  const active: HandGesture[] = [];
  for (const [hand, expires] of until) {
    if (expires > now) active.push(hand);
    else until.delete(hand);
  }
  return active;
}

function toSample(reading: AccelReading): AccelSample {
  return {
    x: round3(reading.x),
    y: round3(reading.y),
    z: round3(reading.z),
    sampledAt: new Date().toISOString(),
  };
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

function tiltWords(deg: number, raised: string, lowered: string): string {
  if (Math.abs(deg) < 3) return 'level';
  return deg > 0 ? `${raised} ${deg}°` : `${lowered} ${Math.abs(deg)}°`;
}

function faceWords(z: number): string {
  if (z > 0.7) return 'lights face up';
  if (z < -0.7) return 'lights face down';
  if (Math.abs(z) < 0.3) return 'lights on edge';
  return z > 0 ? 'lights turning up' : 'lights turning down';
}

function lowSide(sample: AccelSample): { x: number; y: number } {
  const tilt = ringTilt(sample);
  // Positive tilt means that side is up, so the low side is the opposite direction.
  let x = -tilt.acrossDeg / 90;
  let y = tilt.alongDeg / 90;
  const length = Math.hypot(x, y);
  if (length > 1) {
    x /= length;
    y /= length;
  }
  return { x, y };
}

function Level({ sample }: { sample: AccelSample | null }) {
  const dot = sample ? lowSide(sample) : null;
  return (
    <View style={styles.level}>
      <Text style={styles.levelCaption}>fingertip</Text>
      <View style={styles.levelRow}>
        <Text style={styles.levelSide}>left</Text>
        <View style={styles.pad}>
          <View style={styles.crosshairH} />
          <View style={styles.crosshairV} />
          {dot ? (
            <View style={[styles.dot, { left: `${50 + dot.x * 38}%`, top: `${50 + dot.y * 38}%` }]} />
          ) : (
            <Text style={styles.padHint}>Start to see tilt</Text>
          )}
        </View>
        <Text style={styles.levelSide}>right</Text>
      </View>
      <Text style={styles.levelCaption}>knuckle</Text>
    </View>
  );
}

function AxisBar({ label, detail, value }: { label: string; detail: string; value: number | null }) {
  const shown = value ?? 0;
  const clamped = Math.max(-2, Math.min(2, shown));
  const width = (Math.abs(clamped) / 2) * 50;
  const positive = clamped >= 0;
  return (
    <View style={styles.axis}>
      <View style={styles.axisHead}>
        <Text style={styles.axisLabel}>{label}</Text>
        <Text style={styles.axisValue}>{value === null ? '—' : `${shown.toFixed(2)} g`}</Text>
      </View>
      <Text style={styles.meta}>{detail}</Text>
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
    return <Text style={styles.meta}>Shake shows up here once samples arrive.</Text>;
  }
  return (
    <View style={styles.spark}>
      {values.map((value, index) => {
        const shake = Math.abs(value - 1);
        return (
          <View
            key={`${index}-${value.toFixed(3)}`}
            style={[styles.sparkBar, { height: 4 + (Math.min(shake, 2) / 2) * 32 }]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  scroll: {
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
  level: {
    alignItems: 'center',
    gap: 4,
  },
  levelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  levelCaption: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  levelSide: {
    color: colors.muted,
    fontSize: 12,
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
  gestureBar: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    paddingBottom: 20,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  gestureRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipLit: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipLabel: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
  },
  chipLabelLit: {
    color: colors.accentText,
  },
});
