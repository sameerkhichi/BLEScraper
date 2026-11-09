import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { openRing } from '../ble/ringClient';
import { Button, colors } from '../components/ui';
import { RING_HEART_RATE_MINUTES, type RingChecks } from '../model';
import { LOW_BATTERY_PERCENT, LOW_BATTERY_REMIND_HOURS } from '../sync/batteryAlert';
import { CATCHUP_HOURS } from '../sync/schedule';
import { useAppState } from '../state/AppProvider';

export default function SettingsScreen() {
  const { busy, settings, saveAppSettings, applyRingChecks, withRing } = useAppState();
  const [apiUrl, setApiUrl] = useState(settings.apiUrl);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [autoSync, setAutoSync] = useState(settings.autoSync);
  const [factoryGestures, setFactoryGestures] = useState(settings.factoryGestures);
  const [checks, setChecks] = useState<RingChecks>(settings.ringChecks);
  const [checkNote, setCheckNote] = useState('');
  const [gestureNote, setGestureNote] = useState('');

  useEffect(() => {
    setApiUrl(settings.apiUrl);
    setApiKey(settings.apiKey);
    setAutoSync(settings.autoSync);
    setFactoryGestures(settings.factoryGestures);
    setChecks(settings.ringChecks);
  }, [settings.apiUrl, settings.apiKey, settings.autoSync, settings.factoryGestures, settings.ringChecks]);

  const save = async () => {
    await saveAppSettings({
      ...settings,
      apiUrl: apiUrl.trim(),
      apiKey: apiKey.trim(),
      autoSync,
      factoryGestures,
      ringChecks: { ...checks, heartRateMinutes: RING_HEART_RATE_MINUTES },
    });
    router.back();
  };

  const toggleAutoSync = (value: boolean) => {
    setAutoSync(value);
    void saveAppSettings({ ...settings, autoSync: value, factoryGestures });
  };

  const toggleFactoryGestures = (value: boolean) => {
    setFactoryGestures(value);
    setGestureNote('');
    void (async () => {
      await saveAppSettings({ ...settings, autoSync, factoryGestures: value, ringChecks: checks });
      if (!settings.ringId) {
        setGestureNote('Saved. It is written the next time the ring connects.');
        return;
      }
      try {
        await withRing(async () => {
          const client = await openRing(settings.ringId as string);
          await client.setWaveDetector(value);
        });
        setGestureNote(value ? 'The ring wave detector is armed.' : 'The ring wave detector is disarmed.');
      } catch (error) {
        setGestureNote(error instanceof Error ? error.message : 'The ring did not update. The choice is saved for the next connection.');
      }
    })();
  };

  const updateCheck = (key: 'heartRate' | 'spo2' | 'stress' | 'hrv', value: boolean) => {
    const next = { ...checks, [key]: value, heartRateMinutes: RING_HEART_RATE_MINUTES };
    setChecks(next);
    void saveAppSettings({
      ...settings,
      apiUrl: apiUrl.trim(),
      apiKey: apiKey.trim(),
      autoSync,
      factoryGestures,
      ringChecks: next,
    });
  };

  const apply = async () => {
    const next = { ...checks, heartRateMinutes: RING_HEART_RATE_MINUTES };
    await saveAppSettings({
      ...settings,
      apiUrl: apiUrl.trim(),
      apiKey: apiKey.trim(),
      autoSync,
      factoryGestures,
      ringChecks: next,
    });
    try {
      setCheckNote(await applyRingChecks());
    } catch (error) {
      setCheckNote(error instanceof Error ? error.message : 'The ring checks were not updated.');
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.body}>
          The phone POSTs one JSON reading to this URL. Use the public address of the Arduino if it is behind port forwarding.
        </Text>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.label}>Keep syncing</Text>
            <Text style={styles.body}>
              The ring measures heart rate about every {RING_HEART_RATE_MINUTES} minutes while it is worn. Blood oxygen, stress, and HRV follow that cycle. BLEScraper downloads the stored record about every {CATCHUP_HOURS} hours, sends it, and disconnects. Opening the app runs that download when one is due. Leaving the app open does not start extra sensor checks.
              Leave the app in the switcher. iOS chooses the wake time and will not wake the app after you swipe it away. Android shows a notification while a download is running.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Keep syncing"
            onValueChange={(value) => toggleAutoSync(value)}
            thumbColor={colors.text}
            trackColor={{ false: colors.line, true: colors.accent }}
            value={autoSync}
          />
        </View>
        <Text style={styles.body}>
          The phone notifies you when the ring battery is below {LOW_BATTERY_PERCENT}%. It notifies again if the level drops, and every {LOW_BATTERY_REMIND_HOURS} hours while it stays that low.
        </Text>
        <Text style={styles.label}>Ring wave detector</Text>
        <CheckRow
          label="Factory gesture control"
          onValueChange={toggleFactoryGestures}
          value={factoryGestures}
        />
        <Text style={styles.body}>
          Leave this off. The poses on the Accelerometer screen are recognized on the phone from the accelerometer, so they keep working. This switch only arms the wave the ring shipped with, which can skip a song when your hand moves. Each connection writes this choice to the ring. If a song still skips with this off, forget the ring in the phone's Bluetooth list and choose it again here.
        </Text>
        {gestureNote ? <Text style={styles.body}>{gestureNote}</Text> : null}
        <Text style={styles.label}>Ring checks</Text>
        <Text style={styles.body}>
          These run on the ring after the phone disconnects. Heart rate is every {RING_HEART_RATE_MINUTES} minutes. The other three follow that cycle. Apply writes them now. The next download writes them again if the ring disagrees.
        </Text>
        <CheckRow label={`Heart rate every ${RING_HEART_RATE_MINUTES} minutes`} onValueChange={(value) => updateCheck('heartRate', value)} value={checks.heartRate} />
        <CheckRow label="Blood oxygen" onValueChange={(value) => updateCheck('spo2', value)} value={checks.spo2} />
        <CheckRow label="Stress" onValueChange={(value) => updateCheck('stress', value)} value={checks.stress} />
        <CheckRow label="HRV" onValueChange={(value) => updateCheck('hrv', value)} value={checks.hrv} />
        {checkNote ? <Text style={styles.body}>{checkNote}</Text> : null}
        <Button disabled={busy} label="Apply to ring" onPress={() => void apply()} tone="secondary" />
        <Text style={styles.label}>API URL</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onChangeText={setApiUrl}
          placeholder="http://203.0.113.10:8080/ingest"
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={apiUrl}
        />
        <Text style={styles.label}>API key</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setApiKey}
          placeholder="Optional, sent as X-Api-Key"
          placeholderTextColor={colors.muted}
          secureTextEntry
          style={styles.input}
          value={apiKey}
        />
        <Button disabled={busy} label="Save" onPress={() => void save()} />
      </ScrollView>
    </KeyboardAvoidingView>
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
  input: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
});
