import { CMD_READ_HRV, CMD_READ_STRESS } from '../ble/protocol';
import { hasOpenRing, openRing, type RingClient } from '../ble/ringClient';
import { debugLog } from '../ble/debugLog';
import { mergeVitalSpots, vitalSpot, type MetricSample, type ScanKind, type UploadPayload, type VitalSpot } from '../model';
import { STORED_DAYS, type SyncPlan } from './schedule';

async function readMetricDays(
  client: RingClient,
  command: number,
  historyDays: number,
  label: string,
  warnings: string[],
): Promise<MetricSample[]> {
  const samples: MetricSample[] = [];
  for (let daysAgo = historyDays - 1; daysAgo >= 0; daysAgo -= 1) {
    const day = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    try {
      samples.push(...(await client.getIntervalLog(command, day)));
    } catch (error) {
      const message = error instanceof Error ? error.message : `The ring did not return ${label}.`;
      warnings.push(message);
      debugLog(message);
      break;
    }
  }
  return samples;
}

function report(onStatus: (message: string) => void, message: string): void {
  debugLog(message);
  onStatus(message);
}

export type RingRead = {
  worn: boolean;
  sleepLoaded: boolean;
  payload: UploadPayload;
};

export async function syncRing(
  ringId: string,
  ringName: string | null,
  onStatus: (message: string) => void,
): Promise<RingRead> {
  report(onStatus, hasOpenRing(ringId) ? 'Using the open connection' : 'Connecting to the ring');
  const client = await openRing(ringId);
  return collectRing(client, ringId, ringName, { logs: true, vitals: false, sleep: true }, onStatus, {
    probeWear: false,
  });
}

export async function collectRing(
  client: RingClient,
  ringId: string,
  ringName: string | null,
  plan: SyncPlan,
  onStatus: (message: string) => void,
  options?: { probeWear?: boolean; historyDays?: number },
): Promise<RingRead> {
  const warnings: string[] = [];
  let battery: UploadPayload['battery'] = null;
  let heartRate: UploadPayload['heartRate'] = [];
  let steps: UploadPayload['steps'] = [];
  let stress: MetricSample[] = [];
  let hrv: MetricSample[] = [];
  let sleep: UploadPayload['sleep'] = [];
  let sleepLoaded = false;
  let realtimeHeartRate: number | null = null;
  let spo2: number | null = null;
  let bodyTemperatureC: number | null = null;
  let vitalSpots: VitalSpot[] = [];

  const probeWear = options?.probeWear !== false;
  let knownHeartRate: number | null = null;
  let worn = true;
  if (probeWear) {
    report(onStatus, 'Checking that the ring is being worn');
    const wear = await client.checkWorn();
    if (!wear.wearing && wear.reportedOff) {
      report(onStatus, wear.reason);
      worn = false;
      warnings.push(wear.reason);
      // Sleep stays on the ring after it comes off the finger, so this read still saves the night.
      // Live lights and the step log stay off until it is worn again.
      if (!plan.sleep) {
        return {
          worn: false,
          sleepLoaded: false,
          payload: readingPayload(ringId, ringName, { warnings }),
        };
      }
    } else {
      knownHeartRate = wear.wearing ? wear.bpm : null;
      realtimeHeartRate = knownHeartRate;
    }
  }

  if (worn && plan.logs) {
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

    const historyDays = Math.min(Math.max(options?.historyDays ?? 2, 1), STORED_DAYS);
    report(onStatus, 'Reading stored heart rate and steps');
    for (let daysAgo = historyDays - 1; daysAgo >= 0; daysAgo -= 1) {
      const day = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      try {
        heartRate.push(...(await client.getHeartRateLog(day)));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The ring did not return heart rate.';
        warnings.push(message);
        debugLog(message);
      }
      try {
        steps.push(...(await client.getSteps(daysAgo)));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The ring did not return steps.';
        warnings.push(message);
        debugLog(message);
      }
    }

    const takenAt = new Date();
    try {
      report(onStatus, 'Reading stored blood oxygen');
      vitalSpots.push(...(await client.getStoredSpo2(takenAt)));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The ring did not return stored blood oxygen.';
      warnings.push(message);
      debugLog(message);
    }
    try {
      report(onStatus, 'Reading stored temperature');
      vitalSpots.push(...(await client.getStoredTemperature(takenAt)));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The ring did not return stored temperature.';
      warnings.push(message);
      debugLog(message);
    }
    vitalSpots = mergeVitalSpots(vitalSpots);
    spo2 = [...vitalSpots].reverse().find((spot) => typeof spot.spo2 === 'number')?.spo2 ?? null;
    bodyTemperatureC = [...vitalSpots].reverse().find((spot) => typeof spot.bodyTemperatureC === 'number')?.bodyTemperatureC ?? null;
    stress = await readMetricDays(client, CMD_READ_STRESS, historyDays, 'stress', warnings);
    hrv = await readMetricDays(client, CMD_READ_HRV, historyDays, 'HRV', warnings);
  }

  if (worn && plan.vitals) {
    const vitals = await readVitals(client, 'all', onStatus, knownHeartRate);
    realtimeHeartRate = vitals.realtimeHeartRate ?? knownHeartRate;
    spo2 = vitals.spo2;
    bodyTemperatureC = vitals.bodyTemperatureC;
    warnings.push(...vitals.warnings);
    const spot = vitalSpot(spo2, bodyTemperatureC);
    if (spot) vitalSpots = [spot];
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
    worn,
    sleepLoaded,
    payload: readingPayload(ringId, ringName, {
      battery,
      realtimeHeartRate,
      spo2,
      bodyTemperatureC,
      vitalSpots,
      heartRate,
      steps,
      stress,
      hrv,
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
  const payload: UploadPayload = {
    source: 'colmi-r09',
    syncedAt: new Date().toISOString(),
    battery: null,
    realtimeHeartRate: null,
    realtimeHeartRateAt: null,
    spo2: null,
    bodyTemperatureC: null,
    vitalSpots: [],
    accelerometer: null,
    heartRate: [],
    steps: [],
    stress: [],
    hrv: [],
    sleep: [],
    warnings: [],
    ...patch,
    ring: { id: ringId, name: ringName },
  };
  if (typeof payload.realtimeHeartRate === 'number' && !payload.realtimeHeartRateAt) {
    payload.realtimeHeartRateAt = payload.syncedAt;
  }
  return payload;
}

export async function scanRing(
  ringId: string,
  ringName: string | null,
  kind: ScanKind,
  onStatus: (message: string) => void,
): Promise<RingRead> {
  report(onStatus, hasOpenRing(ringId) ? 'Using the open connection' : 'Connecting to the ring');
  const client = await openRing(ringId);
  report(onStatus, 'Checking that the ring is being worn');
  const wear = await client.checkWorn();
  if (!wear.wearing && wear.reportedOff) {
    report(onStatus, wear.reason);
    return {
      worn: false,
      sleepLoaded: false,
      payload: readingPayload(ringId, ringName, { warnings: [wear.reason] }),
    };
  }
  const vitals = await readVitals(client, kind, onStatus, wear.wearing ? wear.bpm : null);
  let battery = null;
  try {
    battery = await client.getBattery();
  } catch {
    battery = null;
  }

  if (vitals.warnings.length > 0) debugLog(vitals.warnings.join(' '));

  return {
    worn: true,
    sleepLoaded: false,
    payload: readingPayload(ringId, ringName, {
      battery,
      realtimeHeartRate: vitals.realtimeHeartRate ?? (wear.wearing ? wear.bpm : null),
      spo2: vitals.spo2,
      bodyTemperatureC: vitals.bodyTemperatureC,
      vitalSpots: spotList(vitals.spo2, vitals.bodyTemperatureC),
      warnings: vitals.warnings,
    }),
  };
}

function spotList(spo2: number | null, bodyTemperatureC: number | null): VitalSpot[] {
  const spot = vitalSpot(spo2, bodyTemperatureC);
  return spot ? [spot] : [];
}

async function readVitals(
  client: RingClient,
  kind: ScanKind,
  onStatus: (message: string) => void,
  knownHeartRate: number | null = null,
): Promise<Pick<UploadPayload, 'realtimeHeartRate' | 'spo2' | 'bodyTemperatureC' | 'warnings'>> {
  const warnings: string[] = [];
  let realtimeHeartRate: number | null = null;
  let spo2: number | null = null;
  let bodyTemperatureC: number | null = null;

  const wantHeart = kind === 'heart-rate' || kind === 'all';
  const wantOxygen = kind === 'spo2' || kind === 'all';
  const wantTemperature = kind === 'temperature' || kind === 'all';

  if (wantHeart) {
    if (knownHeartRate !== null) {
      realtimeHeartRate = knownHeartRate;
      report(onStatus, `Heart rate ${knownHeartRate}`);
    } else {
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
  }

  if (wantOxygen) {
    if (wantHeart) await delay(400);
    report(onStatus, 'Measuring blood oxygen');
    try {
      spo2 = await client.measureBloodOxygen();
      if (spo2 === null) warnings.push('The ring did not return a blood-oxygen reading.');
      else debugLog(`Blood oxygen ${spo2}%`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The ring did not return a blood-oxygen reading.';
      warnings.push(message);
      debugLog(message);
    }
  }

  if (wantTemperature) {
    if (wantHeart || wantOxygen) await delay(400);
    report(onStatus, 'Measuring body temperature');
    try {
      bodyTemperatureC = await client.measureBodyTemperature();
      if (bodyTemperatureC === null) warnings.push('The ring did not return a body-temperature reading.');
      else debugLog(`Body temperature ${bodyTemperatureC}°C`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The ring did not return a body-temperature reading.';
      warnings.push(message);
      debugLog(message);
    }
  }

  return { realtimeHeartRate, spo2, bodyTemperatureC, warnings };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
