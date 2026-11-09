const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const BLE_MODULE = path.join(
  'node_modules',
  '@sfourdrinier',
  'react-native-ble-plx',
  'ios',
  'vendor',
  'MultiplatformBleAdapter',
  'classes',
  'BleModule.swift',
);

// discoverServices(nil) opens every service, including HID. iOS then shows the
// Pair sheet and saves the ring as a media remote. The app only reads these two.
const DISCOVER_ALL = '.discoverServices(nil)';
const DISCOVER_RING = `.discoverServices([
                CBUUID(string: "6E40FFF0-B5A3-F393-E0A9-E50E24DCCA9E"),
                CBUUID(string: "DE5BF728-D711-4E47-AF26-65E3012A5DC7"),
            ])`;

function withColmiServices(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const file = path.join(config.modRequest.projectRoot, BLE_MODULE);
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes(DISCOVER_RING)) return config;
      if (!source.includes(DISCOVER_ALL)) {
        throw new Error('BLE discovery no longer calls discoverServices(nil). The ring would be left able to open HID.');
      }
      fs.writeFileSync(file, source.replace(DISCOVER_ALL, DISCOVER_RING));
      return config;
    },
  ]);
}

module.exports = withColmiServices;
