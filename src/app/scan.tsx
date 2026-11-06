import { ScanMode, type Device } from '@sfourdrinier/react-native-ble-plx';
import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { debugLog, getDebugLines, subscribeDebugLog } from '../ble/debugLog';
import { getBleManager } from '../ble/manager';
import { createScanTracker, type ListedDevice, type ScanSighting } from '../ble/scanList';
import { Button, colors } from '../components/ui';
import { useAppState } from '../state/AppProvider';

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
  const parts = [
    device.likely ? 'Colmi ring' : 'Nearby',
    device.rssi !== null ? `${device.rssi} dBm` : null,
    device.ageSeconds === 0 ? 'seen now' : `seen ${device.ageSeconds}s ago`,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

export default function ScanScreen() {
  const { busy, settings, selectRing, forgetRing } = useAppState();
  const [bleState, setBleState] = useState('Unknown');
  const [devices, setDevices] = useState<ListedDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [debug, setDebug] = useState(true);
  const debugLines = useSyncExternalStore(subscribeDebugLog, getDebugLines);

  useEffect(() => {
    let active = true;
    let scanning = false;
    const manager = getBleManager();
    const tracker = createScanTracker();

    const publish = () => {
      if (!active) return;
      setDevices(tracker.snapshot(Date.now()));
    };

    const interval = setInterval(publish, 1000);
    debugLog('Scanning for Colmi names such as COLMI_CA02');

    const subscription = manager.onStateChange((state) => {
      if (!active) return;
      setBleState(state);
      if (state !== 'PoweredOn') {
        scanning = false;
        void manager.stopDeviceScan();
        return;
      }
      if (scanning) return;
      scanning = true;
      void manager
        .startDeviceScan(
          null,
          { allowDuplicates: true, scanMode: ScanMode.LowLatency },
          (scanError, device) => {
            if (!active) return;
            if (scanError) {
              setError(scanError.message);
              debugLog(`Scan error: ${scanError.message}`);
              return;
            }
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
        });
    }, true);

    return () => {
      active = false;
      clearInterval(interval);
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
        Bluetooth is {bleState}. QRing shows this ring as COLMI_CA02. Hold it against the phone. Names stay on
        screen for about 15 seconds, and the order refreshes every few seconds.
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
          disabled={busy}
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
          disabled={busy}
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
          {debugLines.length === 0 ? (
            <Text style={styles.meta}>Waiting for the first advertisement.</Text>
          ) : (
            debugLines.slice(0, 12).map((line, index) => (
              <Text key={`${index}-${line}`} selectable style={styles.debug}>
                {line}
              </Text>
            ))
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

function DeviceRow({
  device,
  selected,
  debug,
  disabled,
  onPress,
}: {
  device: ListedDevice;
  selected: boolean;
  debug: boolean;
  disabled: boolean;
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
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[styles.row, (device.likely || selected) && styles.likelyRow]}
    >
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
