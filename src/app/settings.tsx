import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native';

import { Button, colors } from '../components/ui';
import { useAppState } from '../state/AppProvider';

export default function SettingsScreen() {
  const { busy, settings, saveAppSettings } = useAppState();
  const [apiUrl, setApiUrl] = useState(settings.apiUrl);
  const [apiKey, setApiKey] = useState(settings.apiKey);

  useEffect(() => {
    setApiUrl(settings.apiUrl);
    setApiKey(settings.apiKey);
  }, [settings.apiUrl, settings.apiKey]);

  const save = async () => {
    await saveAppSettings({
      ...settings,
      apiUrl: apiUrl.trim(),
      apiKey: apiKey.trim(),
    });
    router.back();
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.body}>
          The phone POSTs one JSON reading to this URL. Use the public address of the Arduino if it is behind port forwarding.
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
