import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRingServices } from '../ble/ringServices';
import { Button, Card, colors } from '../components/ui';
import { useAppState } from '../state/AppProvider';

export default function ConfigScreen() {
  const ringServices = useRingServices();
  const { busy, settings, queue, lastPayload, sync, sendPending, forgetRing } = useAppState();
  const insets = useSafeAreaInsets();
  const waiting = queue.length > 0;
  const ringLabel = settings.ringName || settings.ringId || 'No ring selected';
  const apiLabel = settings.apiUrl.trim() || 'No API URL yet';

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
          <Button disabled={busy} label="Sync ring" onPress={syncRing} />
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
});
