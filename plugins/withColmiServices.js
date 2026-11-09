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

const MARKER = '// DISCOVER_RING_DATA';
const FUNCTION = 'func safeDiscoverAllServicesAndCharacteristicsForDevice';
const DISPOSABLE = '        let disposable = peripheral';
const DISPOSABLE_END = '        transactions.replaceDisposable(transactionId, disposable: disposable)';

// CoreBluetooth pairs only when a read or write returns Insufficient Authentication.
// This connect discovers two services and four open data characteristics, and it
// does not discover descriptors.
const DISCOVERY = `        ${MARKER}
        let disposable = peripheral
            .discoverServices([
                CBUUID(string: "6E40FFF0-B5A3-F393-E0A9-E50E24DCCA9E"),
                CBUUID(string: "DE5BF728-D711-4E47-AF26-65E3012A5DC7"),
            ])
            .flatMap { [weak self] services -> Observable<Service> in
                for service in services {
                    self?.discoveredServices[service.jsIdentifier] = service
                }
                return Observable.from(services)
            }
            .flatMap { (service: Service) -> Observable<[Characteristic]> in
                let wanted: [CBUUID]
                if service.uuid == CBUUID(string: "6E40FFF0-B5A3-F393-E0A9-E50E24DCCA9E") {
                    wanted = [
                        CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"),
                        CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"),
                    ]
                } else if service.uuid == CBUUID(string: "DE5BF728-D711-4E47-AF26-65E3012A5DC7") {
                    wanted = [
                        CBUUID(string: "DE5BF729-D711-4E47-AF26-65E3012A5DC7"),
                        CBUUID(string: "DE5BF72A-D711-4E47-AF26-65E3012A5DC7"),
                    ]
                } else {
                    wanted = []
                }
                return service.discoverCharacteristics(wanted)
            }
            .flatMap { [weak self] characteristics -> Observable<Characteristic> in
                for characteristic in characteristics {
                    self?.discoveredCharacteristics[characteristic.jsIdentifier] = characteristic
                }
                return Observable.from(characteristics)
            }
            .subscribe(
                onNext: nil,
                onError: { error in error.bleError.callReject(promise) },
                onCompleted: { promise.resolve(peripheral.asJSObject()) },
                onDisposed: { [weak self] in
                    self?.transactions.removeDisposable(transactionId)
                    BleError.cancelled().callReject(promise)
                }
        )

        transactions.replaceDisposable(transactionId, disposable: disposable)`;

function patchBleModule(source) {
  if (source.includes(MARKER)) return source;
  const fn = source.indexOf(FUNCTION);
  const start = fn < 0 ? -1 : source.indexOf(DISPOSABLE, fn);
  const end = start < 0 ? -1 : source.indexOf(DISPOSABLE_END, start);
  const body = start < 0 || end < 0 ? '' : source.slice(start, end);
  if (!body.includes('.discoverCharacteristics(nil)') || !body.includes('.discoverDescriptors()')) {
    throw new Error(
      'BLE discovery no longer matches the expected CoreBluetooth function. Refusing to build a binary that discovers every characteristic.',
    );
  }
  return source.slice(0, start) + DISCOVERY + source.slice(end + DISPOSABLE_END.length);
}

function withColmiServices(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const file = path.join(config.modRequest.projectRoot, BLE_MODULE);
      const source = fs.readFileSync(file, 'utf8');
      const next = patchBleModule(source);
      if (next !== source) fs.writeFileSync(file, next);
      return config;
    },
  ]);
}

module.exports = withColmiServices;
module.exports.patchBleModule = patchBleModule;
