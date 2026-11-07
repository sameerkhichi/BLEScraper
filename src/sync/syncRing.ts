import { hasOpenRing, openRing, type RingClient } from '../ble/ringClient';
import { debugLog } from '../ble/debugLog';
import type { ScanKind, UploadPayload } from '../model';
import type { SyncPlan } from './schedule';

function report(onStatus: (message: string) => void, message: string): void {
  debugLog(message);
  onStatus(message);
}

export async function syncRing(
  ringId: string,
  ringName: string | null,
  onStatus: (message: string) => void,
): Promise<{ payload: UploadPayload; sleepLoaded: boolean }> {
  report(onStatus, hasOpenRing(ringId) ? 'Using the open connection' : 'Connecting to the ring');
  const client = await openRing(ringId);
  return collectRing(client, ringId, ringName, { logs: true, vitals: false, sleep: true }, onStatus);
}

export async function collectRing(
  client: RingClient,
  ringId: string,
  ringName: string | null,
  plan: SyncPlan,
  onStatus: (message: string) => void,
): Promise<{ payload: UploadPayload; sleepLoaded: boolean }> {
  const warnings: string[] = [];
  let battery: UploadPayload['battery'] = null;
  let heartRate: UploadPayload['heartRate'] = [];
  let steps: UploadPayload['steps'] = [];
  let sleep: UploadPayload['sleep'] = [];
  let sleepLoaded = false;
  let realtimeHeartRate: number | null = null;
  let spo2: number | null = null;
  let bodyTemperatureC: number | null = null;

  if (plan.logs) {
    report(onStatus, 'Setting the ring clock');
    try {
      await client.setTime(new Date());
    } catch {
      warnings.push('The ring clock was not updated.');
      debugLog('The ring clock was not updated.');
    }

    report(onStatus, 'Reading battery');
    battery = await client.getBattery();
    debugLog(`Battery ${battery.level}%${battery.charging ? ', charging' : ''}`);

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    report(onStatus, 'Reading heart rate');
    heartRate = [...(await client.getHeartRateLog(yesterday)), ...(await client.getHeartRateLog(today))];

    report(onStatus, 'Reading steps');
    steps = [...(await client.getSteps(1)), ...(await client.getSteps(0))];
  }

  if (plan.vitals) {
    const vitals = await readVitals(client, 'all', onStatus);
    realtimeHeartRate = vitals.realtimeHeartRate;
    spo2 = vitals.spo2;
    bodyTemperatureC = vitals.bodyTemperatureC;
    warnings.push(...vitals.warnings);
    if (!battery) {
      try {
        battery = await client.getBattery();
      } catch {
        battery = null;
      }
    }
  }

  if (plan.sleep) {
    report(onStatus, 'Reading sleep');
    try {
      sleep = await client.getSleep(new Date());
      sleepLoaded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The ring did not return sleep.';
      warnings.push(message);
      debugLog(message);
    }
  }

  debugLog(
    `Heart-rate samples ${heartRate.length}, step samples ${steps.length}, sleep nights ${sleep.length}`,
  );
  if (warnings.length > 0) debugLog(warnings.join(' '));

  return {
    sleepLoaded,
    payload: readingPayload(ringId, ringName, {
      battery,
      realtimeHeartRate,
      spo2,
      bodyTemperatureC,
      heartRate,
      steps,
      sleep,
      warnings,
    }),
  };
}

export function readingPayload(
  ringId: string,
  ringName: string | null,
  patch: Partial<UploadPayload> = {},
): UploadPayload {
  return {
    source: 'colmi-r09',
    syncedAt: new Date().toISOString(),
    battery: null,
    realtimeHeartRate: null,
    spo2: null,
    bodyTemperatureC: null,
    accelerometer: null,
    heartRate: [],
    steps: [],
    sleep: [],
    warnings: [],
    ...patch,
    ring: { id: ringId, name: ringName },
  };
}

export async function scanRing(
  ringId: string,
  ringName: string | null,
  kind: ScanKind,
  onStatus: (message: string) => void,
): Promise<UploadPayload> {
  report(onStatus, hasOpenRing(ringId) ? 'Using the open connection' : 'Connecting to the ring');
  const client = await openRing(ringId);
  const vitals = await readVitals(client, kind, onStatus);
  let battery = null;
  try {
    battery = await client.getBattery();
  } catch {
    battery = null;
  }

  if (vitals.warnings.length > 0) debugLog(vitals.warnings.join(' '));

  return readingPayload(ringId, ringName, {
    battery,
    realtimeHeartRate: vitals.realtimeHeartRate,
    spo2: vitals.spo2,
    bodyTemperatureC: vitals.bodyTemperatureC,
    warnings: vitals.warnings,
  });
}

async function readVitals(
  client: RingClient,
  kind: ScanKind,
  onStatus: (message: string) => void,
): Promise<Pick<UploadPayload, 'realtimeHeartRate' | 'spo2' | 'bodyTemperatureC' | 'warnings'>> {
  const warnings: string[] = [];
  let realtimeHeartRate: number | null = null;
  let spo2: number | null = null;
  let bodyTemperatureC: number | null = null;

  const wantHeart = kind === 'heart-rate' || kind === 'all';
  const wantOxygen = kind === 'spo2' || kind === 'all';
  const wantTemperature = kind === 'temperature' || kind === 'all';

  if (wantHeart) {
    report(onStatus, 'Measuring heart rate');
    try {
      realtimeHeartRate = await client.measureHeartRate();
      if (realtimeHeartRate === null) warnings.push('The ring did not return a heart-rate reading.');
      else debugLog(`Live heart rate ${realtimeHeartRate}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The ring did not return a heart-rate reading.';
      warnings.push(message);
      debugLog(message);
    }
  }

  if (wantOxygen) {
    if (wantHeart) await delay(400);
    report(onStatus, 'Measuring blood oxygen');
    spo2 = await client.measureBloodOxygen();
    if (spo2 === null) warnings.push('The ring did not return a blood-oxygen reading.');
    else debugLog(`Blood oxygen ${spo2}%`);
  }

  if (wantTemperature) {
    if (wantHeart || wantOxygen) await delay(400);
    report(onStatus, 'Measuring body temperature');
    bodyTemperatureC = await client.measureBodyTemperature();
    if (bodyTemperatureC === null) warnings.push('The ring did not return a body-temperature reading.');
    else debugLog(`Body temperature ${bodyTemperatureC}°C`);
  }

  return { realtimeHeartRate, spo2, bodyTemperatureC, warnings };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
