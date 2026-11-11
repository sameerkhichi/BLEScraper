import { BleManager, type BleRestoredState } from '@sfourdrinier/react-native-ble-plx';
import { Platform } from 'react-native';

import { debugLog } from './debugLog';

// Keep this identical to iosRestorationIdentifier in app.json.
export const BLE_RESTORE_ID = 'com.sameer.blescraper.ble';
const RESTORE_WAIT_MS = 300;

let manager: BleManager | null = null;
let restoredOnce: Promise<void> | null = null;

export function getBleManager(): BleManager {
  if (!manager) {
    manager = new BleManager({ restoreStateIdentifier: BLE_RESTORE_ID });
  }
  return manager;
}

// A normal launch never emits a restore event, and getRestoredState waits until one arrives.
function restoredOrTimeout(ble: BleManager): Promise<BleRestoredState | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), RESTORE_WAIT_MS);
    ble.getRestoredState().then(
      (state) => {
        clearTimeout(timer);
        resolve(state);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

// Read once, before a foreground timer or a background wake connects.
export function prepareRestoredRing(ringId: string | null): Promise<void> {
  if (Platform.OS !== 'ios' || !ringId) return Promise.resolve();
  if (!restoredOnce) restoredOnce = readRestoredRing(ringId);
  return restoredOnce;
}

async function readRestoredRing(ringId: string): Promise<void> {
  try {
    const ble = getBleManager();
    const restored = await restoredOrTimeout(ble);
    const listed = restored?.connectedPeripherals.some((device) => device.id === ringId) ?? false;
    if (!listed) {
      debugLog('No restored ring connection.');
      return;
    }
    const connected = await ble.isDeviceConnected(ringId);
    debugLog(
      connected
        ? `Restored ring ${ringId} is already connected.`
        : `Restored ring ${ringId} needs a reconnect.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read restored Bluetooth state.';
    debugLog(message);
  }
}
