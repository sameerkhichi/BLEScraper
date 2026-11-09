import { ScanMode, type Device } from '@sfourdrinier/react-native-ble-plx';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { debugLog } from '../ble/debugLog';
import { getBleManager } from '../ble/manager';
import { UART_SERVICE_UUID } from '../ble/protocol';
import { closeRing } from '../ble/ringClient';
import { createScanTracker, heldSighting, type ListedDevice, type ScanSighting } from '../ble/scanList';
import { BIG_DATA_SERVICE_UUID } from '../ble/sleep';
import { DebugLog } from '../components/debugLogView';
import { Button, colors } from '../components/ui';
import { useAppState } from '../state/AppProvider';
import { pauseAutoSync, runWithRing } from '../sync/ringGate';

const NEARBY_PREVIEW = 6;

function toSighting(device: Device): ScanSighting {
  const serviceUUIDs = [
    ...(device.serviceUUIDs ?? []),
    ...(device.overflowServiceUUIDs ?? []),
    ...(device.solicitedServiceUUIDs ?? []),
  ];
  return {
    id: device.id,
    name: device.name,
    localName: device.localName,
    rssi: device.rssi,
    serviceUUIDs: serviceUUIDs.length > 0 ? serviceUUIDs : null,
    manufacturerData: device.manufacturerData,
    rawScanRecord: device.rawScanRecord ?? null,
    isConnectable: device.isConnectable,
  };
}

function deviceDetail(device: ListedDevice): string {
  const kind =
    device.match === 'Connected to this phone' || device.match === 'Saved on this phone'
      ? device.match
      : device.likely
        ? 'Colmi ring'
        : 'Nearby';
  const parts = [
    kind,
    device.rssi !== null ? `${device.rssi} dBm` : null,
    device.live ? (device.ageSeconds === 0 ? 'seen now' : `seen ${device.ageSeconds}s ago`) : 'not advertising',
  ];
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

export default function ScanScreen() {
  const { settings, selectRing, forgetRing } = useAppState();
  const [bleState, setBleState] = useState('Unknown');
  const [devices, setDevices] = useState<ListedDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [debug, setDebug] = useState(true);

  const savedId = useRef(settings.ringId);
  const savedName = useRef(settings.ringName);
  savedId.current = settings.ringId;
  savedName.current = settings.ringName;

  useEffect(() => pauseAutoSync(), []);

  useEffect(() => {
    let active = true;
    let scanning = false;
    const manager = getBleManager();
    const tracker = createScanTracker();

    const publish = () => {
      if (!active) return;
      setDevices(tracker.snapshot(Date.now()));
    };

    const loggedHeld = new Set<string>();
    let lastHeldError = '';

    const rememberHeld = async () => {
      const now = Date.now();
      try {
        const connected = await manager.connectedDevices([UART_SERVICE_UUID, BIG_DATA_SERVICE_UUID]);
        if (!active) return;
        for (const device of connected) {
          tracker.observe(
            heldSighting(
              {
                id: device.id,
                name: device.name,
                localName: device.localName,
                rssi: device.rssi,
                serviceUUIDs: device.serviceUUIDs,
              },
              'connected',
              device.id === savedId.current ? savedName.current : null,
            ),
            now,
          );
          if (!loggedHeld.has(device.id)) {
            loggedHeld.add(device.id);
            debugLog(`Phone is already connected to ${device.name || device.localName || device.id}`);
          }
        }
      } catch (heldError) {
        const message = heldError instanceof Error ? heldError.message : 'could not list connected devices';
        if (message !== lastHeldError) {
          lastHeldError = message;
          debugLog(message);
        }
      }

      const id = savedId.current;
      if (!id || tracker.hasFreshAdvertisement(id, Date.now())) {
        publish();
        return;
      }
      try {
        const known = await manager.devices([id]);
        if (!active) return;
        for (const device of known) {
          tracker.observe(
            heldSighting(
              {
                id: device.id,
                name: device.name,
                localName: device.localName,
                rssi: device.rssi,
                serviceUUIDs: device.serviceUUIDs,
              },
              'saved',
              savedName.current,
            ),
            Date.now(),
          );
        }
      } catch (heldError) {
        const message = heldError instanceof Error ? heldError.message : 'could not look up the saved ring';
        if (message !== lastHeldError) {
          lastHeldError = message;
          debugLog(message);
        }
      }
      publish();
    };

    let poweredOn = false;
    let released = false;
    let restarts = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const later = (action: () => void, ms: number) => {
      const timer = setTimeout(() => {
        if (active) action();
      }, ms);
      timers.push(timer);
    };

    const startScan = () => {
      if (!active || !poweredOn || !released || scanning) return;
      scanning = true;
      void manager
        .startDeviceScan(
          null,
          { allowDuplicates: true, scanMode: ScanMode.LowLatency },
          (scanError, device) => {
            if (!active) return;
            if (scanError) {
              scanning = false;
              setError(scanError.message);
              debugLog(`Scan error: ${scanError.message}`);
              void manager.stopDeviceScan();
              if (restarts < 2) {
                restarts += 1;
                later(startScan, 800);
              }
              return;
            }
            restarts = 0;
            if (!device) return;
            const result = tracker.observe(toSighting(device), Date.now());
            if (result.announce) {
              debugLog(`Saw ${result.announce}`);
              publish();
            }
          },
        )
        .catch((scanError: unknown) => {
          scanning = false;
          if (!active) return;
          const message = scanError instanceof Error ? scanError.message : 'Bluetooth scan failed.';
          setError(message);
          debugLog(message);
          if (restarts < 2) {
            restarts += 1;
            later(startScan, 800);
          }
        });
    };

    const releaseAndScan = async () => {
      await runWithRing(async () => {
        await closeRing();
        const id = savedId.current;
        if (!id) return;
        try {
          await manager.cancelDeviceConnection(id);
          debugLog(`Released ${id} so it can advertise`);
        } catch {
          debugLog(`No app link to release for ${id}`);
        }
      });
      await new Promise((resolve) => later(() => resolve(undefined), 800));
      if (!active) return;
      released = true;
      await rememberHeld();
      debugLog('Scanning for Colmi names such as COLMI_CA02');
      startScan();
    };
    void releaseAndScan();

    const interval = setInterval(publish, 1000);
    const heldInterval = setInterval(() => {
      void rememberHeld();
    }, 2000);

    const subscription = manager.onStateChange((state) => {
      if (!active) return;
      setBleState(state);
      if (state !== 'PoweredOn') {
        poweredOn = false;
        scanning = false;
        void manager.stopDeviceScan();
        return;
      }
      poweredOn = true;
      startScan();
    }, true);

    return () => {
      active = false;
      clearInterval(interval);
      clearInterval(heldInterval);
      timers.forEach(clearTimeout);
      subscription.remove();
      void manager.stopDeviceScan();
    };
  }, []);

  const choose = async (device: ListedDevice) => {
    await getBleManager().stopDeviceScan();
    await selectRing(device.id, device.rawName ?? (device.likely ? 'Colmi ring' : null));
    router.back();
  };

  const rings = devices.filter((device) => device.likely);
  const others = devices.filter((device) => !device.likely);
  const visibleOthers = showAll ? others : others.slice(0, NEARBY_PREVIEW);

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.body}>
        Bluetooth is {bleState}. Hold the ring against the phone. If the ring is listed under Settings, Bluetooth, forget
        it there and do not pair it again. This app connects for a download, then disconnects. If iPhone asks to pair,
        Cancel drops the link. Pair puts the ring back in Settings.
      </Text>
      {settings.ringId ? (
        <>
          <Text style={styles.section}>Selected</Text>
          <Text selectable style={styles.name}>
            {settings.ringName || 'Saved ring'}
          </Text>
          <Text selectable style={styles.meta}>
            {settings.ringId}
          </Text>
          <Button label="Disconnect ring" onPress={() => void forgetRing()} tone="danger" />
        </>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.meta}>
        {rings.length === 0
          ? 'No Colmi name yet.'
          : `${rings.length} Colmi match${rings.length === 1 ? '' : 'es'}.`}
        {others.length > 0 ? ` ${others.length} other device${others.length === 1 ? '' : 's'} nearby.` : ''}
      </Text>

      {rings.length > 0 ? <Text style={styles.section}>Rings</Text> : null}
      {rings.map((device) => (
        <DeviceRow
          debug={debug}
          device={device}
          key={device.id}
          onPress={() => void choose(device)}
          selected={device.id === settings.ringId}
        />
      ))}

      {visibleOthers.length > 0 ? <Text style={styles.section}>Other nearby</Text> : null}
      {rings.length === 0 && visibleOthers.length === 0 ? (
        <Text style={styles.meta}>Nothing close enough yet.</Text>
      ) : null}
      {visibleOthers.map((device) => (
        <DeviceRow
          debug={debug}
          device={device}
          key={device.id}
          onPress={() => void choose(device)}
          selected={device.id === settings.ringId}
        />
      ))}

      {others.length > NEARBY_PREVIEW ? (
        <Button
          label={showAll ? 'Show fewer devices' : `Show all ${others.length} nearby devices`}
          onPress={() => setShowAll((current) => !current)}
          tone="secondary"
        />
      ) : null}
      <Button
        label={debug ? 'Hide debug details' : 'Show debug details'}
        onPress={() => setDebug((current) => !current)}
        tone="secondary"
      />
      {debug ? (
        <>
          <Text style={styles.section}>Debug log</Text>
          <DebugLog empty="Waiting for the first advertisement. Earlier lines stay on this phone." />
        </>
      ) : null}
    </ScrollView>
  );
}

function DeviceRow({
  device,
  selected,
  debug,
  onPress,
}: {
  device: ListedDevice;
  selected: boolean;
  debug: boolean;
  onPress: () => void;
}) {
  const debugLines = [
    device.id,
    device.match ?? 'No Colmi name or service',
    device.rawRssi !== null ? `raw ${device.rawRssi} dBm` : null,
    `${device.hits} advertisement${device.hits === 1 ? '' : 's'}`,
    device.connectable === false ? 'not connectable' : null,
    device.serviceUUIDs.length > 0 ? device.serviceUUIDs.join(', ') : 'no advertised services',
    device.manufacturerPreview ? `mfg ${device.manufacturerPreview}` : null,
  ].filter((line): line is string => Boolean(line));

  return (
    <Pressable onPress={onPress} style={[styles.row, (device.likely || selected) && styles.likelyRow]}>
      <Text style={styles.name}>
        {device.name}
        {selected ? ' · Selected' : ''}
      </Text>
      <Text style={styles.meta}>{deviceDetail(device)}</Text>
      {debug ? (
        <Text selectable style={styles.debug}>
          {debugLines.join('\n')}
        </Text>
      ) : null}
    </Pressable>
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
  section: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
    textTransform: 'uppercase',
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
    lineHeight: 18,
  },
  debug: {
    color: colors.muted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 17,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
  },
});
