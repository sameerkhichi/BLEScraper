import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { HEART_RATE_INTERVALS, hasPendingFirmware } from '../ble/ringSettings';
import { Button, colors } from '../components/ui';
import { shownChecks, shownGesture } from '../model';
import { CATCHUP_HOURS } from '../sync/schedule';
import { useAppState } from '../state/AppProvider';

export default function ControlsScreen() {
  const { busy, settings, saveAppSettings, readRingFirmware, writeRingField, applyRingChecks } = useAppState();
  const [autoSync, setAutoSync] = useState(settings.autoSync);
  const [liveRead, setLiveRead] = useState(false);
  const [checkNote, setCheckNote] = useState('');
  const [gestureNote, setGestureNote] = useState('');
  const checks = shownChecks(settings);
  const gesture = shownGesture(settings);
  const pending = hasPendingFirmware(settings.pendingFirmware);
  const hrvUnanswered = Boolean(settings.firmware.readAt) && !settings.firmware.hrv && settings.pendingFirmware.hrv === null;

  useEffect(() => {
    setAutoSync(settings.autoSync);
  }, [settings.autoSync]);

  useEffect(() => {
    if (!settings.ringId) return;
    let cancelled = false;
    void readRingFirmware()
      .then((message) => {
        if (cancelled) return;
        setLiveRead(true);
        setCheckNote(message);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLiveRead(false);
        setCheckNote(error instanceof Error ? error.message : 'The ring did not answer.');
      });
    return () => {
      cancelled = true;
    };
  }, [readRingFirmware, settings.ringId]);

  const toggleAutoSync = (value: boolean) => {
    setAutoSync(value);
    void saveAppSettings({ ...settings, autoSync: value });
  };

  const noteWrite = (message: string) => {
    setCheckNote(message);
    if (!message.includes('Saved on the phone')) setLiveRead(true);
  };

  const changeCheck = (field: 'spo2' | 'stress' | 'hrv', enabled: boolean) => {
    void writeRingField(field, { enabled }).then(noteWrite);
  };

  const writeSaved = async () => {
    try {
      const message = pending ? await applyRingChecks() : await readRingFirmware();
      setLiveRead(true);
      setCheckNote(message);
      setGestureNote('');
    } catch (error) {
      setLiveRead(false);
      setCheckNote(error instanceof Error ? error.message : 'The ring settings were not updated.');
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.label}>Automatic background sync</Text>
          <Text style={styles.body}>
            BLEScraper checks for ring data when iOS allows background activity. That depends on scheduling, settings, battery, and how the phone is used. Opening the app downloads when {CATCHUP_HOURS} hours have passed. Leaving the app open does not start extra sensor checks. Leaving it in the switcher does not promise a wake, and swiping it away can stop the next one until you open it again. A wake sends waiting readings first. The download does not wait for Wi-Fi. A notification is sent when a wake starts, and it says whether that wake is downloading from the ring, uploading waiting readings, or both. It does not send another one when the wake finishes. A download reads the stored record and does not change the ring's settings.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Automatic background sync"
          onValueChange={(value) => toggleAutoSync(value)}
          thumbColor={colors.text}
          trackColor={{ false: colors.line, true: colors.accent }}
          value={autoSync}
        />
      </View>

      <Text style={styles.label}>Factory gesture control</Text>
      {gesture === null ? (
        <Text style={styles.body}>
          {settings.firmware.readAt
            ? 'The ring did not answer. Gesture control was left as it is.'
            : 'Gesture control has not been read from the ring yet.'}
        </Text>
      ) : (
        <CheckRow
          disabled={busy}
          label="Factory gesture control"
          onValueChange={(value) => {
            void writeRingField('gesture', { enabled: value }).then((message) => {
            setGestureNote(message);
            if (!message.includes('Saved on the phone')) setLiveRead(true);
          });
          }}
          value={gesture}
        />
      )}
      <Text style={styles.body}>
        This switch is the on/off saved on the ring. If you need to change it, do it through QRing. That functionality is coming soon.
      </Text>
      {gestureNote ? <Text style={styles.body}>{gestureNote}</Text> : null}

      <Text style={styles.label}>Ring frequency checks</Text>
      <Text style={styles.body}>{firmwareLabel(settings.firmware.readAt, liveRead, pending)}</Text>
      <Text style={styles.body}>
        Heart rate, blood oxygen, stress, and HRV are stored on the ring.
      </Text>
      <CheckRow
        disabled={busy}
        label="Heart rate"
        onValueChange={(value) => {
          void writeRingField('heartRate', { enabled: value, minutes: checks.heartRateMinutes }).then(noteWrite);
        }}
        value={checks.heartRate}
      />
      <Text style={styles.body}>Heart rate interval</Text>
      <View style={styles.intervals}>
        {HEART_RATE_INTERVALS.map((minutes) => {
          const selected = checks.heartRateMinutes === minutes;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              disabled={busy}
              key={minutes}
              onPress={() => {
                void writeRingField('heartRate', { enabled: checks.heartRate, minutes }).then(noteWrite);
              }}
              style={[styles.interval, selected && styles.intervalSelected]}
            >
              <Text style={[styles.intervalLabel, selected && styles.intervalLabelSelected]}>{minutes} min</Text>
            </Pressable>
          );
        })}
      </View>
      {HEART_RATE_INTERVALS.every((minutes) => minutes !== checks.heartRateMinutes) ? (
        <Text style={styles.body}>The ring last reported {checks.heartRateMinutes} minutes.</Text>
      ) : null}
      <Text style={styles.body}>
        Five minutes fills every stored heart-rate slot. Fifteen, thirty, and sixty are the other choices. Fifteen is the cadence often seen on an R09.
      </Text>
      <CheckRow disabled={busy} label="Blood oxygen" onValueChange={(value) => changeCheck('spo2', value)} value={checks.spo2} />
      <CheckRow disabled={busy} label="Stress" onValueChange={(value) => changeCheck('stress', value)} value={checks.stress} />
      {hrvUnanswered ? (
        <Text style={styles.body}>HRV did not answer. It was left as it is.</Text>
      ) : (
        <CheckRow disabled={busy} label="HRV" onValueChange={(value) => changeCheck('hrv', value)} value={checks.hrv} />
      )}
      <Text style={styles.body}>
        Blood oxygen, stress, and HRV have no interval here. The firmware picks the cadence. Stress is about every 30 minutes, HRV about every 60, blood oxygen about hourly, and skin temperature about every 30. Those are observed values, not settings.
      </Text>
      {checkNote ? <Text style={styles.body}>{checkNote}</Text> : null}
      <Button
        disabled={busy}
        label={pending ? 'Write changes to the ring' : 'Read from ring'}
        onPress={() => void writeSaved()}
        tone="secondary"
      />
    </ScrollView>
  );
}

function firmwareLabel(readAt: string | null, live: boolean, pending: boolean): string {
  if (!readAt) return 'Not read from the ring yet.';
  const when = new Date(readAt).toLocaleString();
  if (pending) return `Last read from the ring ${when}. A change is saved on the phone until you write it.`;
  if (live) return `Read from the ring ${when}.`;
  return `Last read from the ring ${when}.`;
}

function CheckRow({
  label,
  value,
  disabled,
  onValueChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.body, styles.rowText]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        disabled={disabled}
        onValueChange={onValueChange}
        thumbColor={colors.text}
        trackColor={{ false: colors.line, true: colors.accent }}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    gap: 12,
    padding: 20,
    paddingBottom: 40,
  },
  body: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 22,
  },
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  rowText: {
    flex: 1,
    gap: 6,
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 8,
    textTransform: 'uppercase',
  },
  intervals: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  interval: {
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  intervalSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  intervalLabel: {
    color: colors.text,
    fontSize: 16,
  },
  intervalLabelSelected: {
    color: colors.accentText,
  },
});
