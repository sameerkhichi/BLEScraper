import { BleManager } from '@sfourdrinier/react-native-ble-plx';

// Keep this identical to iosRestorationIdentifier in app.json.
export const BLE_RESTORE_ID = 'com.sameer.blescraper.ble';

let manager: BleManager | null = null;

export function getBleManager(): BleManager {
  if (!manager) {
    manager = new BleManager({ restoreStateIdentifier: BLE_RESTORE_ID });
  }
  return manager;
}
