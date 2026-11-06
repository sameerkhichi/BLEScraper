import type { Device, Subscription } from '@sfourdrinier/react-native-ble-plx';

import type { BatteryReading, HeartRateSample, StepSample } from '../model';
import { base64ToBytes, bytesToBase64 } from './base64';
import { debugLog } from './debugLog';
import { getBleManager } from './manager';
import { isValidPacket } from './packet';
import type { RawSensorFrame } from './protocol';
import {
  CMD_BATTERY,
  CMD_RAW_SENSOR,
  CMD_READ_HEART_RATE,
  CMD_SET_TIME,
  CMD_START_REAL_TIME,
  CMD_STEPS,
  HeartRateLogParser,
  RAW_SENSOR_DISABLE,
  RAW_SENSOR_ENABLE,
  REALTIME_HEART_RATE,
  REALTIME_SPO2,
  REALTIME_TEMPERATURE,
  SportDetailParser,
  UART_RX_UUID,
  UART_SERVICE_UUID,
  UART_TX_UUID,
  batteryPacket,
  bodyTemperatureCelsius,
  isPlausibleHeartRate,
  isPlausibleSpo2,
  parseBattery,
  parseRawSensor,
  parseRealtime,
  rawSensorPacket,
  readHeartRatePacket,
  readStepsPacket,
  setTimePacket,
  startRealtimePacket,
  stopRealtimePacket,
} from './protocol';

const HISTORY_TIMEOUT_MS = 15000;
const SHORT_TIMEOUT_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class RingClient {
  private subscription: Subscription | null = null;
  private disconnectSubscription: Subscription | null = null;
  private listeners = new Map<number, (packet: Uint8Array) => void>();
  private aborts = new Set<(error: Error) => void>();
  private motionStop: (() => void) | null = null;
  private tail: Promise<void> = Promise.resolve();

  private constructor(private device: Device) {}

  static async connect(deviceId: string): Promise<RingClient> {
    debugLog(`Connecting ${deviceId}`);
    const manager = getBleManager();
    let device: Device;
    try {
      device = await manager.connectToDevice(deviceId, { timeout: 20000 });
      await device.discoverAllServicesAndCharacteristics();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'connection failed';
      debugLog(`Connect failed ${deviceId}: ${message}`);
      throw error;
    }

    let services = 'services unavailable';
    try {
      const found = await device.services();
      services = found.map((service) => service.uuid).join(', ') || 'no services';
    } catch (error) {
      services = error instanceof Error ? error.message : 'could not list services';
    }
    debugLog(`Connected ${deviceId}. ${services}`);

    const client = new RingClient(device);
    client.subscription = device.monitorCharacteristicForService(
      UART_SERVICE_UUID,
      UART_TX_UUID,
      (error, characteristic) => {
        if (error) {
          debugLog(`Notify error on ${deviceId}: ${error.message}`);
          return;
        }
        if (!characteristic?.value) return;
        client.handleNotification(characteristic.value);
      },
    );
    client.disconnectSubscription = device.onDisconnected((error) => {
      debugLog(error?.message ? `Link dropped ${deviceId}: ${error.message}` : `Link closed ${deviceId}`);
      client.failAll(new Error(error?.message ? `The ring disconnected. ${error.message}` : 'The ring disconnected.'));
    });
    await delay(300);
    return client;
  }

  async disconnect(): Promise<void> {
    debugLog(`Disconnecting ${this.device.id}`);
    this.subscription?.remove();
    this.disconnectSubscription?.remove();
    this.subscription = null;
    this.disconnectSubscription = null;
    this.listeners.clear();
    try {
      await this.device.cancelConnection();
    } catch {
      // The link is already closed.
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

  async measureHeartRate(): Promise<number | null> {
    return this.run(() => this.collectRealtime(REALTIME_HEART_RATE, isPlausibleHeartRate, 20000));
  }

  async measureBloodOxygen(): Promise<number | null> {
    return this.run(() => this.collectRealtime(REALTIME_SPO2, isPlausibleSpo2, 30000));
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
            this.aborts.delete(abort);
            resolve();
          };
          const abort = (error: Error) => {
            if (settled) return;
            settled = true;
            this.motionStop = null;
            this.listeners.delete(CMD_RAW_SENSOR);
            this.aborts.delete(abort);
            reject(error);
          };
          this.aborts.add(abort);
          this.motionStop = finish;
          this.listeners.set(CMD_RAW_SENSOR, (packet) => {
            const frame = parseRawSensor(packet);
            if (frame) onFrame(frame);
          });
          this.send(rawSensorPacket(RAW_SENSOR_ENABLE)).catch(abort);
        });
      } finally {
        try {
          await this.send(rawSensorPacket(RAW_SENSOR_DISABLE));
        } catch {
          // The stream has already ended.
        }
      }
    });
  }

  stopMotion(): void {
    this.motionStop?.();
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

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
      this.failAll(new Error('The ring rejected a command.'));
      return;
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
