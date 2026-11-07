import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Button, colors } from '../components/ui';
import { LOW_BATTERY_PERCENT, LOW_BATTERY_REMIND_HOURS } from '../sync/batteryAlert';
import { CATCHUP_HOURS, HISTORY_MINUTES, SLEEP_HOURS, VITALS_MINUTES } from '../sync/schedule';
import { useAppState } from '../state/AppProvider';

export default function SettingsScreen() {
  const { busy, settings, saveAppSettings } = useAppState();
  const [apiUrl, setApiUrl] = useState(settings.apiUrl);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [autoSync, setAutoSync] = useState(settings.autoSync);

  useEffect(() => {
    setApiUrl(settings.apiUrl);
    setApiKey(settings.apiKey);
    setAutoSync(settings.autoSync);
  }, [settings.apiUrl, settings.apiKey, settings.autoSync]);

  const save = async () => {
    await saveAppSettings({
      ...settings,
      apiUrl: apiUrl.trim(),
      apiKey: apiKey.trim(),
      autoSync,
    });
    router.back();
  };

  const toggleAutoSync = (value: boolean) => {
    setAutoSync(value);
    void saveAppSettings({ ...settings, autoSync: value });
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
              While BLEScraper is on screen, steps and stored heart rate are read every {HISTORY_MINUTES} minutes. Live heart rate, SpO2, and temperature run every {VITALS_MINUTES} minutes. Sleep is read about every {SLEEP_HOURS} hours. Each check connects, reads, and disconnects.
              With the screen off or another app in front, that timer pauses. Leave the app in the switcher. About every {CATCHUP_HOURS} hours the phone wakes on its own, downloads the stored record, and if the ring is being worn takes one blood-oxygen and temperature reading. Then it sends and disconnects. Opening the app runs a check when one is due.
              iOS chooses the wake time and will not wake the app after you swipe it away. Android shows a notification only while a download is running.
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
