import type { Device } from '@sfourdrinier/react-native-ble-plx';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { getBleManager } from '../ble/manager';
import { isLikelyRing } from '../ble/protocol';
import { colors } from '../components/ui';
import { useAppState } from '../state/AppProvider';

type SeenDevice = {
  id: string;
  name: string;
  rssi: number | null;
  likely: boolean;
};

function rememberDevice(devices: Map<string, SeenDevice>, device: Device): void {
  const name = device.localName || device.name || 'Unnamed device';
  devices.set(device.id, {
    id: device.id,
    name,
    rssi: device.rssi,
    likely: isLikelyRing(device.localName) || isLikelyRing(device.name),
  });
}

export default function ScanScreen() {
  const { busy, selectRing } = useAppState();
  const [bleState, setBleState] = useState('Unknown');
  const [devices, setDevices] = useState<SeenDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const manager = getBleManager();
    const seen = new Map<string, SeenDevice>();
    const subscription = manager.onStateChange((state) => {
      if (!active) return;
      setBleState(state);
      if (state !== 'PoweredOn') return;
      void manager.startDeviceScan(null, { allowDuplicates: false }, (scanError, device) => {
        if (!active) return;
        if (scanError) {
          setError(scanError.message);
          return;
        }
        if (!device) return;
        rememberDevice(seen, device);
        const next = [...seen.values()].sort((left, right) => {
          if (left.likely !== right.likely) return left.likely ? -1 : 1;
          return (right.rssi ?? -200) - (left.rssi ?? -200);
        });
        setDevices(next.slice(0, 40));
      });
    }, true);

    return () => {
      active = false;
      subscription.remove();
      void manager.stopDeviceScan();
    };
  }, []);

  const choose = async (device: SeenDevice) => {
    await getBleManager().stopDeviceScan();
    await selectRing(device.id, device.name === 'Unnamed device' ? null : device.name);
    router.back();
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.body}>
        Bluetooth is {bleState}. Wear the ring or set it next to the phone, then tap it.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {devices.length === 0 ? <Text style={styles.meta}>Looking for devices…</Text> : null}
      {devices.map((device) => (
        <Pressable
          key={device.id}
          disabled={busy}
          onPress={() => void choose(device)}
          style={styles.row}
        >
          <Text style={styles.name}>{device.name}</Text>
          <Text style={styles.meta}>
            {device.likely ? 'Likely ring' : device.id}
            {device.rssi !== null ? ` · ${device.rssi} dBm` : ''}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
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
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 16,
    borderWidth: 1,
    gap: 4,
    padding: 16,
  },
  name: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  meta: {
    color: colors.muted,
    fontSize: 13,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
  },
});
