import type { UploadPayload } from '../model';
import { debugLog } from '../ble/debugLog';
import { RingClient } from '../ble/ringClient';

function report(onStatus: (message: string) => void, message: string): void {
  debugLog(message);
  onStatus(message);
}

export async function syncRing(
  ringId: string,
  ringName: string | null,
  onStatus: (message: string) => void,
): Promise<UploadPayload> {
  report(onStatus, 'Connecting to the ring');
  const client = await RingClient.connect(ringId);
  const warnings: string[] = [];

  try {
    report(onStatus, 'Setting the ring clock');
    try {
      await client.setTime(new Date());
    } catch {
      warnings.push('The ring clock was not updated.');
      debugLog('The ring clock was not updated.');
    }

    report(onStatus, 'Reading battery');
    const battery = await client.getBattery();
    debugLog(`Battery ${battery.level}%${battery.charging ? ', charging' : ''}`);

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    report(onStatus, 'Reading heart rate');
    const heartRate = [
      ...(await client.getHeartRateLog(yesterday)),
      ...(await client.getHeartRateLog(today)),
    ];

    report(onStatus, 'Reading steps');
    const steps = [...(await client.getSteps(1)), ...(await client.getSteps(0))];
    debugLog(`Heart-rate samples ${heartRate.length}, step samples ${steps.length}`);
    if (warnings.length > 0) debugLog(warnings.join(' '));

    return {
      source: 'colmi-r09',
      syncedAt: new Date().toISOString(),
      ring: { id: ringId, name: ringName },
      battery,
      realtimeHeartRate: null,
      heartRate,
      steps,
      warnings,
    };
  } finally {
    await client.disconnect();
  }
}

export async function measureRing(
  ringId: string,
  ringName: string | null,
  onStatus: (message: string) => void,
): Promise<UploadPayload> {
  report(onStatus, 'Connecting to the ring');
  const client = await RingClient.connect(ringId);
  try {
    report(onStatus, 'Measuring heart rate');
    const realtimeHeartRate = await client.measureHeartRate();
    debugLog(realtimeHeartRate === null ? 'No live heart-rate reading' : `Live heart rate ${realtimeHeartRate}`);
    let battery = null;
    try {
      battery = await client.getBattery();
    } catch {
      battery = null;
    }
    return {
      source: 'colmi-r09',
      syncedAt: new Date().toISOString(),
      ring: { id: ringId, name: ringName },
      battery,
      realtimeHeartRate,
      heartRate: [],
      steps: [],
      warnings:
        realtimeHeartRate === null ? ['The ring did not return a live heart-rate reading.'] : [],
    };
  } finally {
    await client.disconnect();
  }
}
