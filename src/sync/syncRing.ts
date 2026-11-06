import type { UploadPayload } from '../model';
import { RingClient } from '../ble/ringClient';

export async function syncRing(
  ringId: string,
  ringName: string | null,
  onStatus: (message: string) => void,
): Promise<UploadPayload> {
  onStatus('Connecting to the ring');
  const client = await RingClient.connect(ringId);
  const warnings: string[] = [];

  try {
    onStatus('Setting the ring clock');
    try {
      await client.setTime(new Date());
    } catch {
      warnings.push('The ring clock was not updated.');
    }

    onStatus('Reading battery');
    const battery = await client.getBattery();

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    onStatus('Reading heart rate');
    const heartRate = [
      ...(await client.getHeartRateLog(yesterday)),
      ...(await client.getHeartRateLog(today)),
    ];

    onStatus('Reading steps');
    const steps = [...(await client.getSteps(1)), ...(await client.getSteps(0))];

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
  onStatus('Connecting to the ring');
  const client = await RingClient.connect(ringId);
  try {
    onStatus('Measuring heart rate');
    const realtimeHeartRate = await client.measureHeartRate();
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
