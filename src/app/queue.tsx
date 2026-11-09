import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';

import { Button, Card, colors } from '../components/ui';
import type { UploadPayload } from '../model';
import type { PendingUpload } from '../sync/queue';
import { useAppState } from '../state/AppProvider';

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function describe(payload: UploadPayload): string[] {
  const lines: string[] = [];
  const heartRate = count(payload.heartRate);
  const steps = count(payload.steps);
  const sleep = count(payload.sleep);
  if (typeof payload.realtimeHeartRate === 'number') lines.push(`Heart rate ${payload.realtimeHeartRate} bpm`);
  if (typeof payload.spo2 === 'number') lines.push(`Blood oxygen ${payload.spo2}%`);
  if (typeof payload.bodyTemperatureC === 'number') lines.push(`Temperature ${payload.bodyTemperatureC.toFixed(1)}°C`);
  if (payload.accelerometer) {
    const { x, y, z } = payload.accelerometer;
    lines.push(`Accelerometer ${x.toFixed(2)} x, ${y.toFixed(2)} y, ${z.toFixed(2)} z g`);
  }
  if (heartRate > 0) lines.push(`${heartRate} stored heart-rate sample${heartRate === 1 ? '' : 's'}`);
  const stress = count(payload.stress);
  const hrv = count(payload.hrv);
  if (stress > 0) lines.push(`${stress} stress sample${stress === 1 ? '' : 's'}`);
  if (hrv > 0) lines.push(`${hrv} HRV sample${hrv === 1 ? '' : 's'}`);
  if (steps > 0) lines.push(`${steps} step sample${steps === 1 ? '' : 's'}`);
  if (sleep > 0) lines.push(`${sleep} sleep night${sleep === 1 ? '' : 's'}`);
  if (payload.battery) {
    lines.push(`Battery ${payload.battery.level}%${payload.battery.charging ? ', charging' : ''}`);
  }
  if (lines.length === 0) lines.push('No samples in this reading.');
  return lines;
}

export default function QueueScreen() {
  const { busy, settings, queue, sendPending, removePending, clearPending } = useAppState();
  const [openId, setOpenId] = useState<string | null>(null);
  const destination = settings.apiUrl.trim();

  const confirmRemove = (item: PendingUpload) => {
    Alert.alert('Remove this reading?', 'It will not be sent to the API.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removePending(item.id) },
    ]);
  };

  const confirmClear = () => {
    Alert.alert('Remove every waiting reading?', 'None of them will be sent to the API.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Remove all', style: 'destructive', onPress: () => void clearPending() },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text selectable style={styles.body}>
        {destination || 'No API URL yet. Readings stay on the phone until you add one in Settings.'}
      </Text>
      <Text style={styles.meta}>
        {queue.length === 0
          ? 'Nothing waiting to send.'
          : `${queue.length} reading${queue.length === 1 ? '' : 's'} waiting, oldest first.`}
      </Text>

      <Button
        disabled={busy || queue.length === 0}
        label="Send waiting readings"
        onPress={() => void sendPending()}
        tone="secondary"
      />
      {queue.length > 0 ? <Button label="Remove all" onPress={confirmClear} tone="danger" /> : null}

      {queue.length === 0 ? (
        <Card>
          <Text style={styles.label}>Queue empty</Text>
          <Text style={styles.meta}>A sync or a measurement adds a reading here when it cannot be sent yet.</Text>
        </Card>
      ) : (
        queue.map((item, index) => {
          const open = openId === item.id;
          return (
            <Card key={item.id}>
              <Text style={styles.label}>{`Reading ${index + 1}`}</Text>
              <Text style={styles.meta}>{`Queued ${new Date(item.createdAt).toLocaleString()}`}</Text>
              <Text style={styles.meta}>{`Taken ${new Date(item.payload.syncedAt).toLocaleString()}`}</Text>
              {describe(item.payload).map((line, lineIndex) => (
                <Text key={`${item.id}-${lineIndex}`} style={styles.body}>
                  {line}
                </Text>
              ))}
              {(Array.isArray(item.payload.warnings) ? item.payload.warnings : []).map((warning) => (
                <Text key={warning} style={styles.warning}>
                  {warning}
                </Text>
              ))}
              <Button
                label={open ? 'Hide packet' : 'Show packet'}
                onPress={() => setOpenId(open ? null : item.id)}
                tone="secondary"
              />
              {open ? (
                <Text selectable style={styles.packet}>
                  {JSON.stringify(item.payload, null, 2)}
                </Text>
              ) : null}
              <Button label="Remove" onPress={() => confirmRemove(item)} tone="danger" />
            </Card>
          );
        })
      )}
    </ScrollView>
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
  packet: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
});
