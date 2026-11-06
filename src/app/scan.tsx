import type { Device } from '@sfourdrinier/react-native-ble-plx';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { getBleManager } from '../ble/manager';
import { UART_SERVICE_UUID, advertisesColmiService, isLikelyRing } from '../ble/protocol';
import { Button, colors } from '../components/ui';
import { useAppState } from '../state/AppProvider';

type SeenDevice = {
  id: string;
  name: string;
  rssi: number | null;
  likely: boolean;
};

function rememberDevice(device: Device, serviceFiltered: boolean): SeenDevice {
  const advertisedName = device.localName || device.name;
  const likely =
    serviceFiltered ||
    advertisesColmiService(device.serviceUUIDs) ||
    isLikelyRing(advertisedName);
  return {
    id: device.id,
    name: advertisedName || (likely ? 'Colmi ring' : 'Unnamed device'),
    rssi: device.rssi,
    likely,
  };
}

function shouldList(device: SeenDevice, showAll: boolean): boolean {
  if (!showAll || device.likely) return true;
  const rssi = device.rssi ?? -200;
  if (device.name === 'Unnamed device') return rssi >= -70;
  return rssi >= -90;
}

export default function ScanScreen() {
  const { busy, selectRing } = useAppState();
  const [bleState, setBleState] = useState('Unknown');
  const [devices, setDevices] = useState<SeenDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let active = true;
    const manager = getBleManager();
    const seen = new Map<string, SeenDevice>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const publish = () => {
      const next = [...seen.values()]
        .filter((device) => shouldList(device, showAll))
        .sort((left, right) => {
          if (left.likely !== right.likely) return left.likely ? -1 : 1;
          return (right.rssi ?? -200) - (left.rssi ?? -200);
        });
      setDevices(next.slice(0, 20));
    };

    const subscription = manager.onStateChange((state) => {
      if (!active) return;
      setBleState(state);
      if (state !== 'PoweredOn') return;
      const serviceFilter = showAll ? null : [UART_SERVICE_UUID];
      void manager
        .startDeviceScan(serviceFilter, { allowDuplicates: true }, (scanError, device) => {
          if (!active) return;
          if (scanError) {
            setError(scanError.message);
            return;
          }
          if (!device) return;
          seen.set(device.id, rememberDevice(device, !showAll));
          if (flushTimer) return;
          flushTimer = setTimeout(() => {
            flushTimer = null;
            if (active) publish();
          }, 400);
        })
        .catch((scanError: unknown) => {
          if (!active) return;
          setError(scanError instanceof Error ? scanError.message : 'Bluetooth scan failed.');
        });
    }, true);

    return () => {
      active = false;
      if (flushTimer) clearTimeout(flushTimer);
      subscription.remove();
      void manager.stopDeviceScan();
    };
  }, [showAll]);

  const choose = async (device: SeenDevice) => {
    await getBleManager().stopDeviceScan();
    const savedName = device.name === 'Colmi ring' || device.name === 'Unnamed device' ? null : device.name;
    await selectRing(device.id, savedName ?? (device.likely ? 'Colmi ring' : null));
    router.back();
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.body}>
        Bluetooth is {bleState}. The ring usually advertises no name. Hold it against the phone.
        {showAll
          ? ' Showing the closest devices. The strongest signal is the most likely ring.'
          : ' This list is only devices advertising the Colmi service.'}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {devices.length === 0 ? (
        <Text style={styles.meta}>
          {showAll ? 'Nothing close enough yet.' : 'Looking for the ring service…'}
        </Text>
      ) : null}
      {devices.map((device, index) => (
        <Pressable
          key={device.id}
          disabled={busy}
          onPress={() => void choose(device)}
          style={[styles.row, device.likely && styles.likelyRow]}
        >
          <Text style={styles.name}>{device.name}</Text>
          <Text style={styles.meta}>
            {device.likely ? 'Colmi service' : index === 0 ? 'Closest device' : 'Nearby'}
            {device.rssi !== null ? ` · ${device.rssi} dBm` : ''}
          </Text>
        </Pressable>
      ))}
      {showAll ? null : (
        <Button
          label="Show all nearby devices"
          onPress={() => setShowAll(true)}
          tone="secondary"
        />
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
  likelyRow: {
    borderColor: colors.accent,
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
