import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { openRing } from '../ble/ringClient';
import { Button, colors } from '../components/ui';
import { RING_HEART_RATE_MINUTES, type RingChecks } from '../model';
import { LOW_BATTERY_PERCENT, LOW_BATTERY_REMIND_HOURS } from '../sync/batteryAlert';
import { CATCHUP_HOURS } from '../sync/schedule';
import {
  FEVER_C,
  MILD_HYPOTHERMIA_C,
  MODERATE_HYPOTHERMIA_C,
  SEVERE_HYPOTHERMIA_C,
  TEMP_ALERT_REMIND_HOURS,
  fahrenheit,
} from '../sync/temperatureAlert';
import { useAppState } from '../state/AppProvider';

export default function ControlsScreen() {
  const { busy, settings, saveAppSettings, applyRingChecks, withRing } = useAppState();
  const [autoSync, setAutoSync] = useState(settings.autoSync);
  const [factoryGestures, setFactoryGestures] = useState(settings.factoryGestures);
  const [checks, setChecks] = useState<RingChecks>(settings.ringChecks);
  const [checkNote, setCheckNote] = useState('');
  const [gestureNote, setGestureNote] = useState('');

  useEffect(() => {
    setAutoSync(settings.autoSync);
    setFactoryGestures(settings.factoryGestures);
    setChecks(settings.ringChecks);
  }, [settings.autoSync, settings.factoryGestures, settings.ringChecks]);

  const toggleAutoSync = (value: boolean) => {
    setAutoSync(value);
    void saveAppSettings({ ...settings, autoSync: value });
  };

  const toggleFactoryGestures = (value: boolean) => {
    setFactoryGestures(value);
    setGestureNote('');
    void (async () => {
      await saveAppSettings({ ...settings, factoryGestures: value, ringChecks: checks });
      if (!settings.ringId) {
        setGestureNote('Saved. It is written the next time the ring connects.');
        return;
      }
      try {
        await withRing(async () => {
          const client = await openRing(settings.ringId as string);
          await client.setWaveDetector(value);
        });
        setGestureNote(
          value
            ? 'Armed until this connection ends. The app turns it off again on disconnect.'
            : 'Factory gesture control is off. It is written again when the app disconnects.',
        );
      } catch (error) {
        setGestureNote(error instanceof Error ? error.message : 'The ring did not update. The choice is saved for the next connection.');
      }
    })();
  };

  const updateCheck = (key: 'heartRate' | 'spo2' | 'stress' | 'hrv', value: boolean) => {
    const next = { ...checks, [key]: value, heartRateMinutes: RING_HEART_RATE_MINUTES };
    setChecks(next);
    void saveAppSettings({ ...settings, ringChecks: next });
  };

  const apply = async () => {
    const next = { ...checks, heartRateMinutes: RING_HEART_RATE_MINUTES };
    await saveAppSettings({ ...settings, ringChecks: next });
    try {
      setCheckNote(await applyRingChecks());
    } catch (error) {
      setCheckNote(error instanceof Error ? error.message : 'The ring checks were not updated.');
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.label}>Automatic background sync</Text>
          <Text style={styles.body}>
            The ring measures heart rate about every {RING_HEART_RATE_MINUTES} minutes while it is worn. Blood oxygen, stress, and HRV follow that cycle. BLEScraper downloads the stored record about every {CATCHUP_HOURS} hours, sends it, and disconnects. Opening the app runs that download when one is due. Leaving the app open does not start extra sensor checks. Leave the app in the switcher. The next wake does not require opening the app. iOS chooses the time and will not wake the app after you swipe it away. The download does not wait for Wi-Fi. A notification is sent when the wake starts and when it finishes.
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
      <Text style={styles.body}>
        The phone notifies you when the ring battery is below {LOW_BATTERY_PERCENT}%. It notifies again if the level drops, and every {LOW_BATTERY_REMIND_HOURS} hours while it stays that low.
      </Text>
      <Text style={styles.body}>
        Body temperature notifies at {FEVER_C}°C ({fahrenheit(FEVER_C).toFixed(1)}°F) or higher, and when it falls below {MILD_HYPOTHERMIA_C}°C ({fahrenheit(MILD_HYPOTHERMIA_C).toFixed(0)}°F, mild), {MODERATE_HYPOTHERMIA_C}°C ({fahrenheit(MODERATE_HYPOTHERMIA_C).toFixed(1)}°F, moderate), or {SEVERE_HYPOTHERMIA_C}°C ({fahrenheit(SEVERE_HYPOTHERMIA_C).toFixed(1)}°F, severe). It notifies again when the reading crosses a worse line, and every {TEMP_ALERT_REMIND_HOURS} hours while it stays there.
      </Text>

      <Text style={styles.label}>Factory gesture control</Text>
      <CheckRow label="Factory gesture control" onValueChange={toggleFactoryGestures} value={factoryGestures} />
      <Text style={styles.body}>
        Leave this off. Turning it on is the ring's own gesture control, and that is what skips a song when the ring moves. The app turns it off again every time it disconnects, including after a sync. Poses on the Accelerometer screen are recognized on the phone and do not use it. If a song still skips with this off, the phone has the ring saved as a media remote. That can stay quiet right after you tap Pair and start the next morning, when iOS connects the saved bond. Forget the ring in Bluetooth Settings and do not tap Pair. The app connects on its own for each download.
      </Text>
      {gestureNote ? <Text style={styles.body}>{gestureNote}</Text> : null}

      <Text style={styles.label}>Ring frequency checks</Text>
      <Text style={styles.body}>
        These run on the ring after the phone disconnects. Heart rate is every {RING_HEART_RATE_MINUTES} minutes. The other three follow that cycle. Apply writes them now. The next download writes them again if the ring disagrees.
      </Text>
      <CheckRow
        label={`Heart rate every ${RING_HEART_RATE_MINUTES} minutes`}
        onValueChange={(value) => updateCheck('heartRate', value)}
        value={checks.heartRate}
      />
      <CheckRow label="Blood oxygen" onValueChange={(value) => updateCheck('spo2', value)} value={checks.spo2} />
      <CheckRow label="Stress" onValueChange={(value) => updateCheck('stress', value)} value={checks.stress} />
      <CheckRow label="HRV" onValueChange={(value) => updateCheck('hrv', value)} value={checks.hrv} />
      {checkNote ? <Text style={styles.body}>{checkNote}</Text> : null}
      <Button disabled={busy} label="Apply to ring" onPress={() => void apply()} tone="secondary" />
    </ScrollView>
  );
}

function CheckRow({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.body, styles.rowText]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
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
});
