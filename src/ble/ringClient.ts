import type { Device, Subscription } from '@sfourdrinier/react-native-ble-plx';

import type { BatteryReading, HeartRateSample, MetricSample, SleepNight, StepSample, VitalSpot } from '../model';
import { base64ToBytes, bytesToBase64 } from './base64';
import { debugLog } from './debugLog';
import { rememberRingServices } from './ringServices';
import { getBleManager } from './manager';
import { isValidPacket } from './packet';
import {
  type RawSensorFrame,
  CMD_BATTERY,
  CMD_GESTURE,
  CMD_RAW_SENSOR,
  CMD_READ_HEART_RATE,
  CMD_SET_TIME,
  CMD_START_REAL_TIME,
  CMD_STEPS,
  HeartRateLogParser,
  IntervalLogParser,
  RAW_SENSOR_DISABLE,
  RAW_SENSOR_ENABLE,
  REALTIME_HEART_RATE,
  REALTIME_SPO2,
  REALTIME_STRESS,
  REALTIME_TEMPERATURE,
  SportDetailParser,
  UART_RX_UUID,
  UART_SERVICE_UUID,
  UART_TX_UUID,
  GESTURE_ARM,
  GESTURE_DISABLE,
  GESTURE_ENABLE,
  GESTURE_WAVE,
  batteryPacket,
  bodyTemperatureCelsius,
  classifyWear,
  isPlausibleSpo2,
  parseBattery,
  parseLiveHeartRate,
  parseLiveStress,
  gesturePacket,
  parseRawSensor,
  parseRealtime,
  rawSensorPacket,
  readHeartRatePacket,
  readSeriesPacket,
  readStepsPacket,
  setTimePacket,
  smoothHeartRate,
  startHeartRatePacket,
  startRealtimePacket,
  stopRealtimePacket,
} from './protocol';
import {
  CMD_PALM,
  commandFor,
  parseSetting,
  readSettingPacket,
  settingMatches,
  writeSettingPacket,
  type FirmwareRead,
  type ParsedSetting,
  type SettingField,
  type SettingPatch,
} from './ringSettings';
import {
  BIG_DATA_RX_UUID,
  BIG_DATA_SERVICE_UUID,
  BIG_DATA_TX_UUID,
  BigDataAssembler,
  parseSleepPacket,
  sleepRequestPacket,
} from './sleep';
import { parseStoredSpo2, parseStoredTemperature, STORED_SPO2, STORED_TEMPERATURE, storedSeriesRequest } from './storedVitals';

const HISTORY_TIMEOUT_MS = 15000;
const SERIES_TIMEOUT_MS = 8000;
const SHORT_TIMEOUT_MS = 5000;
const HEART_RATE_TIMEOUT_MS = 35000;
// Long enough to see an off-finger packet. The heart-rate measurement waits on its own.
const WEAR_PROBE_MS = 8000;
// A fresh start is a rough number. One measurement stays open until it returns a beat.
const LIVE_HEART_WINDOW = 5;
const LIVE_HEART_QUIET_MS = 2500;

export const NOT_WORN_MESSAGE = 'Ring is not being worn. Leaving it asleep.';

export type HeartRateFrame = { kind: 'bpm'; bpm: number } | { kind: 'ppg'; value: number };

export type WearCheck =
  | { wearing: true; bpm: number }
  | { wearing: false; reportedOff: boolean; reason: string };

type BleFailure = {
  message?: string;
  reason?: string | null;
  errorCode?: number | null;
  iosErrorCode?: number | null;
  androidErrorCode?: number | null;
  attErrorCode?: number | null;
};

function protectedAttribute(error: BleFailure): boolean {
  return error.attErrorCode === 5 || error.attErrorCode === 8 || error.attErrorCode === 15;
}

function describeBleError(error: BleFailure): string {
  const reason = error.reason?.trim();
  const generic = !error.message || error.message.startsWith('Unknown error occurred');
  const detail = reason || (generic ? null : error.message);
  const codes = [
    error.iosErrorCode != null ? `iOS ${error.iosErrorCode}` : null,
    error.androidErrorCode != null ? `Android ${error.androidErrorCode}` : null,
    error.attErrorCode != null ? `ATT ${error.attErrorCode}` : null,
    error.errorCode != null ? `code ${error.errorCode}` : null,
  ].filter((part): part is string => Boolean(part));
  if (detail && codes.length > 0) return `${detail} (${codes.join(', ')})`;
  if (detail) return detail;
  if (codes.length > 0) return codes.join(', ');
  return 'Unknown Bluetooth error.';
}

function toHex(packet: Uint8Array): string {
  return Array.from(packet.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class RingClient {
  private subscription: Subscription | null = null;
  private bigDataSubscription: Subscription | null = null;
  private bigDataReady = false;
  private bigDataWaiters = new Set<(chunk: Uint8Array) => void>();
  private sleepAbort: ((error: Error) => void) | null = null;
  private notifying = false;
  private open = true;
  private disconnectSubscription: Subscription | null = null;
  private listeners = new Map<number, (packet: Uint8Array) => void>();
  private aborts = new Set<(error: Error) => void>();
  private motionStop: (() => void) | null = null;
  private heartStop: (() => void) | null = null;
  private tail: Promise<void> = Promise.resolve();

  private constructor(private device: Device) {}

  static async connect(deviceId: string): Promise<RingClient> {
    debugLog(`Connecting ${deviceId}`);
    const manager = getBleManager();
    let device: Device | null = null;
    let client: RingClient | null = null;
    let setupFailed: Error | null = null;
    try {
      try {
        if (await manager.isDeviceConnected(deviceId)) {
          debugLog(`Ring ${deviceId} is already connected.`);
          const known = await manager.devices([deviceId]);
          device = known.find((item) => item.id === deviceId) ?? null;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not check the ring connection.';
        debugLog(message);
      }
      if (!device) device = await manager.connectToDevice(deviceId, { timeout: 20000 });
      // The iOS build discovers the UART and sleep services and the four data
      // characteristics only. It does not read or write an encrypted attribute,
      // so CoreBluetooth does not start a bond.
      debugLog('Discovering the data services');
      await device.discoverAllServicesAndCharacteristics();

      let services = 'services unavailable';
      try {
        const found = await device.services();
        const ids = found.map((service) => service.uuid);
        rememberRingServices(ids);
        services = ids.join(', ') || 'no services';
      } catch (error) {
        services = error instanceof Error ? error.message : 'could not list services';
      }
      debugLog(`Connected ${deviceId}. ${services}`);

      const ring = new RingClient(device);
      client = ring;
      ring.notifying = true;
      const dropProtected = (where: string, error: BleFailure) => {
        if (!protectedAttribute(error)) return;
        debugLog(`Protected attribute on ${where}. Dropping the link.`);
        if (device) void device.cancelConnection().catch(() => undefined);
      };
      debugLog('Subscribing to UART notify 6E400003');
      ring.subscription = device.monitorCharacteristicForService(
        UART_SERVICE_UUID,
        UART_TX_UUID,
        (error, characteristic) => {
          if (error) {
            if (!ring.notifying) return;
            dropProtected('UART notify 6E400003', error);
            const wrapped = new Error(`The ring stopped sending data. ${describeBleError(error)}`);
            setupFailed ??= wrapped;
            debugLog(`Notify error on ${deviceId}: ${describeBleError(error)}`);
            ring.failAll(wrapped);
            return;
          }
          if (!characteristic?.value) return;
          ring.handleNotification(characteristic.value);
        },
      );
      try {
        debugLog('Subscribing to big-data notify DE5BF729');
        ring.bigDataSubscription = device.monitorCharacteristicForService(
          BIG_DATA_SERVICE_UUID,
          BIG_DATA_TX_UUID,
          (error, characteristic) => {
            if (error) {
              if (!ring.notifying) return;
              dropProtected('big-data notify DE5BF729', error);
              debugLog(`Sleep notify error on ${deviceId}: ${describeBleError(error)}`);
              ring.failBigData(new Error(`The ring did not send sleep data. ${describeBleError(error)}`));
              return;
            }
            if (!characteristic?.value) return;
            const chunk = base64ToBytes(characteristic.value);
            ring.bigDataWaiters.forEach((waiter) => waiter(chunk));
          },
        );
        ring.bigDataReady = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'sleep notifications unavailable';
        debugLog(`Sleep channel unavailable on ${deviceId}: ${message}`);
      }
      ring.disconnectSubscription = device.onDisconnected((error) => {
        ring.open = false;
        forgetRingSession(ring);
        debugLog(error?.message ? `Link dropped ${deviceId}: ${error.message}` : `Link closed ${deviceId}`);
        ring.failAll(new Error(error?.message ? `The ring disconnected. ${error.message}` : 'The ring disconnected.'));
      });
      await delay(300);
      if (setupFailed || !ring.open) throw setupFailed ?? new Error('The ring disconnected.');
      return ring;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'connection failed';
      debugLog(`Connect failed ${deviceId}: ${message}`);
      if (client) {
        try {
          await client.disconnect();
        } catch {
          // The failed attempt left no link to drop.
        }
      } else if (device) {
        try {
          await device.cancelConnection();
        } catch {
          // The failed attempt left no link to drop.
        }
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    debugLog(`Disconnecting ${this.device.id}`);
    this.open = false;
    this.notifying = false;
    forgetRingSession(this);
    this.failAll(new Error('The ring disconnected.'));
    this.subscription?.remove();
    this.bigDataSubscription?.remove();
    this.disconnectSubscription?.remove();
    this.subscription = null;
    this.bigDataSubscription = null;
    this.disconnectSubscription = null;
    this.bigDataWaiters.clear();
    this.listeners.clear();
    try {
      await this.device.cancelConnection();
    } catch {
      // The link is already closed.
    }
  }

  isLive(): boolean {
    return this.open;
  }

  async connected(): Promise<boolean> {
    if (!this.open) return false;
    try {
      return await this.device.isConnected();
    } catch {
      return false;
    }
  }

  async setTime(target: Date): Promise<void> {
    await this.run(async () => {
      await this.request(CMD_SET_TIME, setTimePacket(target), () => true, SHORT_TIMEOUT_MS);
    });
  }

  async getBattery(): Promise<BatteryReading> {
    return this.run(() =>
      this.request(CMD_BATTERY, batteryPacket(), (packet) => parseBattery(packet), SHORT_TIMEOUT_MS),
    );
  }

  async getHeartRateLog(day: Date): Promise<HeartRateSample[]> {
    return this.run(async () => {
      const parser = new HeartRateLogParser();
      const result = await this.request(
        CMD_READ_HEART_RATE,
        readHeartRatePacket(day),
        (packet) => parser.parse(packet),
        HISTORY_TIMEOUT_MS,
      );
      return result.kind === 'none' ? [] : result.samples;
    });
  }

  async getSleep(now = new Date()): Promise<SleepNight[]> {
    return this.run(async () => {
      const packet = await this.readBigData(sleepRequestPacket(), HISTORY_TIMEOUT_MS, 'Sleep');
      const nights = parseSleepPacket(packet, now);
      debugLog(`Sleep nights ${nights.length}`);
      return nights;
    });
  }

  async readFirmware(): Promise<FirmwareRead> {
    return this.run(async () => {
      const warnings: string[] = [];
      const heartRate = await this.readParsed(commandFor('heartRate'), 'Heart rate', warnings);
      const spo2 = await this.readParsed(commandFor('spo2'), 'Blood oxygen', warnings);
      const stress = await this.readParsed(commandFor('stress'), 'Stress', warnings);
      const hrv = await this.readParsed(commandFor('hrv'), 'HRV', warnings);
      const gesture = await this.readGestureSetting(warnings);
      return {
        readAt: new Date().toISOString(),
        heartRate,
        spo2,
        stress,
        hrv,
        hrvAnswered: hrv !== null,
        gesture: gesture?.parsed ?? null,
        gestureCommand: gesture?.command ?? null,
        warnings,
      };
    });
  }

  async writeFirmwareField(current: FirmwareRead, field: SettingField, patch: SettingPatch): Promise<FirmwareRead> {
    return this.run(async () => {
      const warnings: string[] = [];
      let command = field === 'gesture' ? current.gestureCommand : commandFor(field);
      let baseline = current;
      if (field === 'gesture' && command == null) {
        const found = await this.readGestureSetting(warnings);
        if (!found) {
          warnings.push('The ring did not answer, so gesture control was left as it is.');
          return { ...current, warnings };
        }
        command = found.command;
        baseline = { ...current, gesture: found.parsed, gestureCommand: found.command };
      }
      if (command == null) return { ...current, warnings };
      if (field === 'hrv') {
        const answered = await this.readParsed(command, 'HRV', warnings, true);
        if (!answered) {
          warnings.push('HRV was not written because the ring did not answer.');
          return { ...baseline, hrv: null, hrvAnswered: false, warnings };
        }
        baseline = { ...baseline, hrv: answered, hrvAnswered: true };
      }
      const previous = (await this.readParsed(command, fieldLabel(field), warnings, true)) ?? settingFor(baseline, field);
      if (!previous) {
        warnings.push(`${fieldLabel(field)} was not written because the ring did not answer.`);
        return { ...baseline, warnings };
      }
      let confirmed = await this.writeAndConfirm(command, writeSettingPacket(command, previous, patch));
      if (confirmed && !patch.enabled && confirmed.enabled && (patch.offByte ?? previous.offByte) !== 0x00) {
        confirmed = await this.writeAndConfirm(command, writeSettingPacket(command, previous, { ...patch, offByte: 0x00 }));
      }
      if (!confirmed) {
        warnings.push(`${fieldLabel(field)} was not read back.`);
        return { ...baseline, warnings };
      }
      if (!settingMatches(confirmed, patch)) {
        warnings.push(`${fieldLabel(field)} still shows the previous value.`);
      }
      return placeSetting(baseline, field, confirmed, command, warnings);
    });
  }

  async getIntervalLog(command: number, day: Date): Promise<MetricSample[]> {
    return this.run(async () => {
      const parser = new IntervalLogParser();
      const result = await this.request(
        command,
        readSeriesPacket(command, day),
        (packet) => parser.parse(packet),
        SERIES_TIMEOUT_MS,
      );
      return result.kind === 'none' ? [] : result.samples;
    });
  }

  async getStoredSpo2(now = new Date()): Promise<VitalSpot[]> {
    return this.run(async () => {
      const packet = await this.readBigData(storedSeriesRequest(STORED_SPO2), HISTORY_TIMEOUT_MS, 'Blood oxygen');
      return parseStoredSpo2(packet, now);
    });
  }

  async getStoredTemperature(now = new Date()): Promise<VitalSpot[]> {
    return this.run(async () => {
      const packet = await this.readBigData(storedSeriesRequest(STORED_TEMPERATURE), HISTORY_TIMEOUT_MS, 'Temperature');
      return parseStoredTemperature(packet, now);
    });
  }

  async getSteps(dayOffset: number): Promise<StepSample[]> {
    return this.run(async () => {
      const parser = new SportDetailParser();
      const result = await this.request(
        CMD_STEPS,
        readStepsPacket(dayOffset),
        (packet) => parser.parse(packet),
        HISTORY_TIMEOUT_MS,
      );
      return Array.isArray(result) ? result : [];
    });
  }

  async checkWorn(): Promise<WearCheck> {
    return this.run(() => this.probeWear(WEAR_PROBE_MS));
  }

  async measureHeartRate(): Promise<number | null> {
    return this.run(() => this.collectHeartRate(HEART_RATE_TIMEOUT_MS));
  }

  async measureBloodOxygen(): Promise<number | null> {
    return this.run(() => this.collectRealtime(REALTIME_SPO2, isPlausibleSpo2, 30000));
  }

  async measureStress(): Promise<number | null> {
    return this.run(() => this.collectStress(30000));
  }

  async measureBodyTemperature(): Promise<number | null> {
    return this.run(async () => {
      const raw = await this.collectRealtime(
        REALTIME_TEMPERATURE,
        (value) => bodyTemperatureCelsius(value) !== null,
        30000,
      );
      return raw === null ? null : bodyTemperatureCelsius(raw);
    });
  }

  async watchMotion(onFrame: (frame: RawSensorFrame) => void): Promise<void> {
    return this.run(async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            this.motionStop = null;
            this.listeners.delete(CMD_RAW_SENSOR);
            this.listeners.delete(CMD_GESTURE);
            this.aborts.delete(abort);
            resolve();
          };
          const abort = (error: Error) => {
            if (settled) return;
            settled = true;
            this.motionStop = null;
            this.listeners.delete(CMD_RAW_SENSOR);
            this.listeners.delete(CMD_GESTURE);
            this.aborts.delete(abort);
            reject(error);
          };
          this.aborts.add(abort);
          this.motionStop = finish;
          this.listeners.set(CMD_RAW_SENSOR, (packet) => {
            const frame = parseRawSensor(packet);
            if (frame) onFrame(frame);
          });
          this.listeners.set(CMD_GESTURE, (packet) => {
            if (packet[1] === GESTURE_WAVE) onFrame({ kind: 'wave' });
          });
          this.send(rawSensorPacket(RAW_SENSOR_ENABLE)).catch(abort);
        });
      } finally {
        await this.stopRawSensors();
      }
    });
  }

  stopMotion(): void {
    this.motionStop?.();
  }

  async watchHeartRate(onFrame: (frame: HeartRateFrame) => void): Promise<void> {
    return this.run(async () => {
      let quiet: ReturnType<typeof setTimeout> | null = null;
      const clearQuiet = () => {
        if (!quiet) return;
        clearTimeout(quiet);
        quiet = null;
      };
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let offTimer: ReturnType<typeof setTimeout> | null = null;
          let sawBpm = false;
          // True from the moment a start is sent until that measurement returns a beat.
          let measuring = true;
          const recent: number[] = [];
          const clearOff = () => {
            if (!offTimer) return;
            clearTimeout(offTimer);
            offTimer = null;
          };
          const finish = () => {
            if (settled) return;
            settled = true;
            clearQuiet();
            clearOff();
            this.heartStop = null;
            this.listeners.delete(CMD_START_REAL_TIME);
            this.aborts.delete(abort);
            resolve();
          };
          const abort = (error: Error) => {
            if (settled) return;
            settled = true;
            clearQuiet();
            clearOff();
            this.heartStop = null;
            this.listeners.delete(CMD_START_REAL_TIME);
            this.aborts.delete(abort);
            reject(error);
          };
          // One start at a time. Another request before the beat comes back clears the sensor and nothing arrives.
          const scheduleNext = () => {
            clearQuiet();
            if (settled || measuring) return;
            quiet = setTimeout(() => {
              quiet = null;
              if (settled || measuring) return;
              measuring = true;
              debugLog('Asking for the next heart-rate sample');
              this.send(startHeartRatePacket()).catch(() => undefined);
            }, LIVE_HEART_QUIET_MS);
          };
          this.aborts.add(abort);
          this.heartStop = finish;
          this.listeners.set(CMD_START_REAL_TIME, (packet) => {
            const bpm = parseLiveHeartRate(packet);
            if (bpm !== null) {
              clearOff();
              sawBpm = true;
              measuring = false;
              recent.push(bpm);
              if (recent.length > LIVE_HEART_WINDOW) recent.shift();
              const steady = smoothHeartRate(recent) ?? bpm;
              debugLog(`Heart rate ${bpm}`);
              onFrame({ kind: 'bpm', bpm: steady });
              scheduleNext();
              return;
            }
            debugLog(`Heart-rate packet ${toHex(packet)}`);
            if (classifyWear(packet) !== 'off') {
              clearOff();
              return;
            }
            const quietMs = sawBpm ? 8000 : 15000;
            if (!offTimer) offTimer = setTimeout(() => abort(new Error(NOT_WORN_MESSAGE)), quietMs);
          });
          const start = startHeartRatePacket();
          debugLog(`Heart-rate start ${toHex(start)}`);
          this.send(start).catch(abort);
        });
      } finally {
        clearQuiet();
        try {
          await this.send(stopRealtimePacket(REALTIME_HEART_RATE));
        } catch {
          // The stop command can fail after the ring has already ended the reading.
        }
      }
    });
  }

  stopHeartRate(): void {
    this.heartStop?.();
  }

  async setWaveDetector(armed: boolean): Promise<void> {
    await this.run(async () => {
      if (!armed) {
        await this.send(gesturePacket(GESTURE_DISABLE));
        await this.send(rawSensorPacket(RAW_SENSOR_DISABLE));
        // The ring applies this after the write returns. Disconnecting immediately leaves the old mode on.
        await delay(400);
        debugLog('Disarmed the ring wave detector');
        return;
      }
      await this.send(gesturePacket(GESTURE_ENABLE));
      await this.send(gesturePacket(GESTURE_ARM));
      debugLog('Armed the ring wave detector');
    });
  }

  private async stopRawSensors(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.send(rawSensorPacket(RAW_SENSOR_DISABLE));
        debugLog('Asked the ring to turn the sensor lights off');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'stop failed';
        debugLog(`Could not turn the sensor lights off: ${message}`);
      }
      if (attempt === 0) await delay(200);
    }
  }

  private async probeWear(timeoutMs: number): Promise<WearCheck> {
    const reading = await this.readLiveHeartRate(timeoutMs);
    if (reading.bpm !== null) {
      debugLog(`Ring is being worn. Heart rate ${reading.bpm}`);
      return { wearing: true, bpm: reading.bpm };
    }
    if (reading.reportedOff) {
      debugLog('Ring reported that it is not being worn.');
      return { wearing: false, reportedOff: true, reason: NOT_WORN_MESSAGE };
    }
    debugLog('No heart-rate reading during the wear check.');
    return { wearing: false, reportedOff: false, reason: 'The ring did not return a heart-rate reading.' };
  }

  private async collectHeartRate(timeoutMs: number): Promise<number | null> {
    const reading = await this.readLiveHeartRate(timeoutMs);
    return reading.bpm;
  }

  private async readLiveHeartRate(timeoutMs: number): Promise<{ bpm: number | null; reportedOff: boolean }> {
    let bpm: number | null = null;
    let reportedOff = false;
    let lastPacket: Uint8Array | null = null;

    const forget = () => {
      this.listeners.delete(CMD_START_REAL_TIME);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let offTimer: ReturnType<typeof setTimeout> | null = null;
        const clearOff = () => {
          if (!offTimer) return;
          clearTimeout(offTimer);
          offTimer = null;
        };
        const timer = setTimeout(() => complete(), timeoutMs);
        const complete = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearOff();
          forget();
          this.aborts.delete(abort);
          resolve();
        };
        const abort = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearOff();
          forget();
          this.aborts.delete(abort);
          reject(error);
        };
        this.aborts.add(abort);

        const accept = (value: number | null) => {
          if (value === null) return;
          clearOff();
          bpm = value;
          complete();
        };

        this.listeners.set(CMD_START_REAL_TIME, (packet) => {
          lastPacket = packet;
          const value = parseLiveHeartRate(packet);
          if (value !== null) {
            accept(value);
            return;
          }
          const wear = classifyWear(packet);
          if (wear === 'pending') {
            clearOff();
            return;
          }
          reportedOff = true;
          const status = packet[2] ?? 0;
          debugLog(`Wear packet ${toHex(packet)} status ${status}`);
          if (status >= 3) {
            complete();
            return;
          }
          if (!offTimer) offTimer = setTimeout(() => complete(), 3000);
        });
        const start = startHeartRatePacket();
        debugLog(`Heart-rate start ${toHex(start)}`);
        this.send(start).catch(abort);
      });
    } finally {
      try {
        await this.send(stopRealtimePacket(REALTIME_HEART_RATE));
      } catch {
        // The stop command can fail after the ring has already ended the reading.
      }
    }

    if (bpm === null) {
      debugLog(
        lastPacket
          ? `Heart-rate packet ${toHex(lastPacket)} was not a reading.`
          : 'No heart-rate packet arrived.',
      );
    }
    return { bpm, reportedOff };
  }

  private async collectRealtime(
    readingType: number,
    accept: (value: number) => boolean,
    timeoutMs: number,
  ): Promise<number | null> {
    const readings: number[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => complete(), timeoutMs);
        const complete = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.listeners.delete(CMD_START_REAL_TIME);
          this.aborts.delete(abort);
          resolve();
        };
        const abort = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.listeners.delete(CMD_START_REAL_TIME);
          this.aborts.delete(abort);
          reject(error);
        };
        this.aborts.add(abort);
        this.listeners.set(CMD_START_REAL_TIME, (packet) => {
          const parsed = parseRealtime(packet);
          if (parsed.kind === 'error' || parsed.reading !== readingType || !accept(parsed.value)) return;
          readings.push(parsed.value);
          if (readings.length >= 2) complete();
        });
        this.send(startRealtimePacket(readingType)).catch(abort);
      });
    } finally {
      try {
        await this.send(stopRealtimePacket(readingType));
      } catch {
        // A reading is still usable when the stop command fails.
      }
    }

    return readings.length === 0 ? null : readings[readings.length - 1];
  }

  private async collectStress(timeoutMs: number): Promise<number | null> {
    const readings: number[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => complete(), timeoutMs);
        const complete = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.listeners.delete(CMD_START_REAL_TIME);
          this.aborts.delete(abort);
          resolve();
        };
        const abort = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.listeners.delete(CMD_START_REAL_TIME);
          this.aborts.delete(abort);
          reject(error);
        };
        this.aborts.add(abort);
        this.listeners.set(CMD_START_REAL_TIME, (packet) => {
          const value = parseLiveStress(packet);
          if (value === null) return;
          readings.push(value);
          if (readings.length >= 2) complete();
        });
        this.send(startRealtimePacket(REALTIME_STRESS)).catch(abort);
      });
    } finally {
      try {
        await this.send(stopRealtimePacket(REALTIME_STRESS));
      } catch {
        // A reading is still usable when the stop command fails.
      }
    }

    return readings.length === 0 ? null : readings[readings.length - 1];
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readParsed(command: number, label: string, warnings: string[], quiet = false): Promise<ParsedSetting | null> {
    try {
      return await this.request(command, readSettingPacket(command), (packet) => parseSetting(packet, command), SHORT_TIMEOUT_MS);
    } catch (error) {
      if (!quiet) warnings.push(error instanceof Error ? error.message : `${label} was not read.`);
      return null;
    }
  }

  private async readGestureSetting(warnings: string[]): Promise<{ command: number; parsed: ParsedSetting } | null> {
    for (const command of [CMD_PALM, CMD_GESTURE]) {
      const parsed = await this.readParsed(command, 'Gesture control', warnings, true);
      if (parsed) return { command, parsed };
    }
    warnings.push('The ring did not answer gesture control.');
    return null;
  }

  private async writeAndConfirm(command: number, packet: Uint8Array): Promise<ParsedSetting | null> {
    let echoed: ParsedSetting | null = null;
    try {
      echoed = await this.request(command, packet, (incoming) => parseSetting(incoming, command), SHORT_TIMEOUT_MS);
    } catch (error) {
      debugLog(error instanceof Error ? error.message : `Command ${command} was not acknowledged.`);
    }
    try {
      return await this.request(command, readSettingPacket(command), (incoming) => parseSetting(incoming, command), SHORT_TIMEOUT_MS);
    } catch (error) {
      debugLog(error instanceof Error ? error.message : `Command ${command} was not read back.`);
      return echoed;
    }
  }

  private async readBigData(request: Uint8Array, timeoutMs: number, label: string): Promise<Uint8Array> {
    if (!this.bigDataReady) {
      throw new Error(`This ring did not expose ${label.toLowerCase()} data.`);
    }

    const assembler = new BigDataAssembler();
    let abort = (_error: Error) => undefined;

    const pending = new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.bigDataWaiters.delete(waiter);
        this.aborts.delete(abort);
        if (this.sleepAbort === abort) this.sleepAbort = null;
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        debugLog(`${label} request on ${this.device.id} timed out after ${timeoutMs}ms`);
        reject(new Error('The ring did not answer in time.'));
      }, timeoutMs);
      abort = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const waiter = (chunk: Uint8Array) => {
        if (settled) return;
        try {
          const packet = assembler.push(chunk);
          if (!packet) return;
          settled = true;
          cleanup();
          resolve(packet);
        } catch (error) {
          abort(error instanceof Error ? error : new Error(`Could not read the ${label.toLowerCase()} packet.`));
        }
      };
      this.aborts.add(abort);
      this.bigDataWaiters.add(waiter);
      this.sleepAbort = abort;
    });
    pending.catch(() => undefined);

    try {
      await this.sendBigData(request);
    } catch (error) {
      abort(error instanceof Error ? error : new Error(`Could not request ${label.toLowerCase()} data.`));
    }
    return pending;
  }

  private failBigData(error: Error): void {
    this.sleepAbort?.(error);
  }

  private async sendBigData(packet: Uint8Array): Promise<void> {
    await this.device.writeCharacteristicWithResponseForService(
      BIG_DATA_SERVICE_UUID,
      BIG_DATA_RX_UUID,
      bytesToBase64(packet),
    );
  }

  private async send(packet: Uint8Array): Promise<void> {
    await this.device.writeCharacteristicWithoutResponseForService(
      UART_SERVICE_UUID,
      UART_RX_UUID,
      bytesToBase64(packet),
    );
  }

  private handleNotification(value: string): void {
    const packet = base64ToBytes(value);
    if (!isValidPacket(packet)) return;
    const command = packet[0];
    // Raw sensor packets use 0xA1. That bit is an error flag on the lower command ids.
    if (command !== CMD_RAW_SENSOR && (command & 0x80) !== 0) {
      debugLog(`Ring ${this.device.id} rejected command ${command & 0x7f}`);
      return;
    }
    if (command === 29 || command === 28) {
      debugLog(`Ring music packet ${command} byte ${packet[1] ?? 0}`);
    }
    this.listeners.get(command)?.(packet.subarray(0, 16));
  }

  private failAll(error: Error): void {
    this.listeners.clear();
    const pending = [...this.aborts];
    this.aborts.clear();
    pending.forEach((abort) => abort(error));
  }

  private request<T>(
    command: number,
    packet: Uint8Array,
    parse: (packet: Uint8Array) => T | null,
    timeoutMs: number,
  ): Promise<T> {
    const pending = new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.listeners.delete(command);
        this.aborts.delete(abort);
        debugLog(`Command ${command} on ${this.device.id} timed out after ${timeoutMs}ms`);
        reject(new Error('The ring did not answer in time.'));
      }, timeoutMs);

      const abort = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(command);
        this.aborts.delete(abort);
        reject(error);
      };
      this.aborts.add(abort);

      this.listeners.set(command, (incoming) => {
        if (settled) return;
        try {
          const parsed = parse(incoming);
          if (parsed === null) return;
          settled = true;
          clearTimeout(timer);
          this.listeners.delete(command);
          this.aborts.delete(abort);
          resolve(parsed);
        } catch (error) {
          abort(error instanceof Error ? error : new Error('Could not read the ring packet.'));
        }
      });
    });

    pending.catch(() => undefined);

    return this.send(packet).then(
      () => pending,
      (error: unknown) => {
        this.listeners.delete(command);
        throw error;
      },
    );
  }
}

type OpenSession = { ringId: string; client: RingClient };
let openSession: OpenSession | null = null;

function forgetRingSession(client: RingClient): void {
  if (openSession?.client === client) openSession = null;
}

function shouldRetryConnect(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return !/powered off|unauthorized|not authorized|permission/i.test(message);
}

export function hasOpenRing(ringId: string): boolean {
  return openSession?.ringId === ringId && openSession.client.isLive();
}

export async function openRing(ringId: string): Promise<RingClient> {
  const current = openSession;
  if (current?.ringId === ringId && (await current.client.connected())) {
    debugLog(`Reusing connection ${ringId}`);
    return current.client;
  }
  await closeRing();
  try {
    const client = await RingClient.connect(ringId);
    openSession = { ringId, client };
    return client;
  } catch (error) {
    if (!shouldRetryConnect(error)) throw error;
    const message = error instanceof Error ? error.message : 'connection failed';
    debugLog(`Dropping a stuck phone link after: ${message}`);
    try {
      await getBleManager().cancelDeviceConnection(ringId);
    } catch {
      // The phone had no link left to drop.
    }
    await delay(1500);
    const client = await RingClient.connect(ringId);
    openSession = { ringId, client };
    return client;
  }
}

function fieldLabel(field: SettingField): string {
  switch (field) {
    case 'heartRate':
      return 'Heart rate';
    case 'spo2':
      return 'Blood oxygen';
    case 'stress':
      return 'Stress';
    case 'hrv':
      return 'HRV';
    case 'gesture':
      return 'Gesture control';
  }
}

function settingFor(read: FirmwareRead, field: SettingField): ParsedSetting | null {
  switch (field) {
    case 'heartRate':
      return read.heartRate;
    case 'spo2':
      return read.spo2;
    case 'stress':
      return read.stress;
    case 'hrv':
      return read.hrv;
    case 'gesture':
      return read.gesture;
  }
}

function placeSetting(
  current: FirmwareRead,
  field: SettingField,
  parsed: ParsedSetting,
  command: number,
  warnings: string[],
): FirmwareRead {
  const next: FirmwareRead = { ...current, warnings, readAt: new Date().toISOString() };
  if (field === 'heartRate') next.heartRate = parsed;
  if (field === 'spo2') next.spo2 = parsed;
  if (field === 'stress') next.stress = parsed;
  if (field === 'hrv') {
    next.hrv = parsed;
    next.hrvAnswered = true;
  }
  if (field === 'gesture') {
    next.gesture = parsed;
    next.gestureCommand = command;
  }
  return next;
}

export async function closeRing(ringId?: string): Promise<boolean> {
  const current = openSession;
  if (!current) return false;
  if (ringId && current.ringId !== ringId) return false;
  openSession = null;
  await current.client.disconnect();
  return true;
}
