import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { debugLog } from '../ble/debugLog';
import { getBleManager } from '../ble/manager';
import { mergeReadings, type AccelSample, type AppSettings, type ScanKind, type UploadPayload } from '../model';
import { enqueue, flushQueue, type PendingUpload } from '../sync/queue';
import {
  loadLastPayload,
  loadQueue,
  loadSettings,
  saveLastPayload,
  saveQueue,
  saveSettings,
} from '../sync/storage';
import { readingPayload, scanRing, syncRing } from '../sync/syncRing';
import { postPayload } from '../sync/upload';

type AppContextValue = {
  ready: boolean;
  busy: boolean;
  status: string;
  settings: AppSettings;
  queue: PendingUpload[];
  lastPayload: UploadPayload | null;
  saveAppSettings: (settings: AppSettings) => Promise<void>;
  selectRing: (ringId: string, ringName: string | null) => Promise<void>;
  forgetRing: () => Promise<void>;
  sync: () => Promise<void>;
  scan: (kind: ScanKind) => Promise<void>;
  recordMotion: (sample: AccelSample) => Promise<void>;
  withRing: <T>(action: () => Promise<T>) => Promise<T>;
  sendPending: () => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ready when the ring is nearby.');
  const [settings, setSettings] = useState<AppSettings>({
    apiUrl: '',
    apiKey: '',
    ringId: null,
    ringName: null,
  });
  const [queue, setQueue] = useState<PendingUpload[]>([]);
  const [lastPayload, setLastPayload] = useState<UploadPayload | null>(null);
  const ringUse = useRef(0);

  const publishQueue = useCallback(async (next: PendingUpload[]) => {
    setQueue(next);
    await saveQueue(next);
  }, []);

  const sendQueue = useCallback(
    async (nextQueue: PendingUpload[], currentSettings: AppSettings) => {
      if (!currentSettings.apiUrl.trim()) {
        setStatus('Saved on the phone. Add an API URL in Settings to send it.');
        return;
      }
      setStatus('Sending to the API');
      const result = await flushQueue(nextQueue, (payload) => postPayload(currentSettings, payload));
      await publishQueue(result.remaining);
      if (result.error) {
        setStatus(
          result.sent > 0
            ? `Sent ${result.sent}. ${result.remaining.length} still waiting. ${result.error}`
            : `Waiting to send. ${result.error}`,
        );
        return;
      }
      setStatus(result.sent > 0 ? 'Synced and sent.' : 'Nothing waiting to send.');
    },
    [publishQueue],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [storedSettings, storedQueue, storedLast] = await Promise.all([
        loadSettings(),
        loadQueue(),
        loadLastPayload(),
      ]);
      if (cancelled) return;
      setSettings(storedSettings);
      setQueue(storedQueue);
      setLastPayload(storedLast);
      setReady(true);
      if (storedSettings.apiUrl.trim() && storedQueue.length > 0) {
        await sendQueue(storedQueue, storedSettings);
      }
    };
    load().catch((error: unknown) => {
      if (!cancelled) {
        setStatus(error instanceof Error ? error.message : 'Could not load saved data.');
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sendQueue]);

  const remember = useCallback(async (payload: UploadPayload) => {
    setLastPayload(payload);
    await saveLastPayload(payload);
  }, []);

  const withRing = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    ringUse.current += 1;
    setBusy(true);
    try {
      return await action();
    } finally {
      ringUse.current = Math.max(0, ringUse.current - 1);
      if (ringUse.current === 0) setBusy(false);
    }
  }, []);

  const saveAppSettings = useCallback(
    async (next: AppSettings) => {
      setSettings(next);
      await saveSettings(next);
      if (queue.length > 0) {
        await sendQueue(queue, next);
      } else {
        setStatus('Settings saved.');
      }
    },
    [queue, sendQueue],
  );

  const releaseRing = useCallback(async (ringId: string | null) => {
    if (!ringId) return;
    try {
      await getBleManager().cancelDeviceConnection(ringId);
      debugLog(`Cancelled connection ${ringId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'not connected';
      debugLog(`No open connection for ${ringId}: ${message}`);
    }
  }, []);

  const selectRing = useCallback(
    async (ringId: string, ringName: string | null) => {
      const previous = settings.ringId;
      const next = { ...settings, ringId, ringName };
      setSettings(next);
      await saveSettings(next);
      if (previous && previous !== ringId) await releaseRing(previous);
      setStatus(`Saved ${ringName || 'ring'}.`);
      debugLog(`Selected ${ringName || ringId}`);
    },
    [releaseRing, settings],
  );

  const forgetRing = useCallback(async () => {
    const ringId = settings.ringId;
    const next = { ...settings, ringId: null, ringName: null };
    setSettings(next);
    await saveSettings(next);
    await releaseRing(ringId);
    setStatus('Disconnected.');
    debugLog('Forgot the selected ring');
  }, [releaseRing, settings]);

  const sync = useCallback(async () => {
    if (!settings.ringId) {
      setStatus('Choose the ring first.');
      return;
    }
    await withRing(async () => {
      try {
        const payload = await syncRing(settings.ringId!, settings.ringName, setStatus);
        await remember(mergeReadings(lastPayload, payload, false));
        const nextQueue = enqueue(queue, payload);
        await publishQueue(nextQueue);
        await sendQueue(nextQueue, settings);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Sync failed.';
        debugLog(message);
        setStatus(message);
      }
    });
  }, [lastPayload, publishQueue, queue, remember, sendQueue, settings, withRing]);

  const scan = useCallback(async (kind: ScanKind) => {
    if (!settings.ringId) {
      setStatus('Choose the ring first.');
      return;
    }
    await withRing(async () => {
      try {
        const payload = await scanRing(settings.ringId!, settings.ringName, kind, setStatus);
        const succeeded =
          payload.realtimeHeartRate !== null || payload.spo2 !== null || payload.bodyTemperatureC !== null;
        if (!succeeded) {
          setStatus(payload.warnings.join(' ') || 'The ring did not return a reading.');
          return;
        }
        await remember(mergeReadings(lastPayload, payload, true));
        const nextQueue = enqueue(queue, payload);
        await publishQueue(nextQueue);
        await sendQueue(nextQueue, settings);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Measurement failed.';
        debugLog(message);
        setStatus(message);
      }
    });
  }, [lastPayload, publishQueue, queue, remember, sendQueue, settings, withRing]);

  const recordMotion = useCallback(async (sample: AccelSample) => {
    if (!settings.ringId) {
      setStatus('Choose the ring first.');
      return;
    }
    const payload = readingPayload(settings.ringId, settings.ringName, { accelerometer: sample });
    await remember(mergeReadings(lastPayload, payload, true));
    const nextQueue = enqueue(queue, payload);
    await publishQueue(nextQueue);
    await sendQueue(nextQueue, settings);
  }, [lastPayload, publishQueue, queue, remember, sendQueue, settings]);

  const sendPending = useCallback(async () => {
    setBusy(true);
    try {
      await sendQueue(queue, settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed.';
      debugLog(message);
      setStatus(message);
    } finally {
      setBusy(false);
    }
  }, [queue, sendQueue, settings]);

  const value = useMemo(
    () => ({
      ready,
      busy,
      status,
      settings,
      queue,
      lastPayload,
      saveAppSettings,
      selectRing,
      forgetRing,
      sync,
      scan,
      recordMotion,
      withRing,
      sendPending,
    }),
    [
      ready,
      busy,
      status,
      settings,
      queue,
      lastPayload,
      saveAppSettings,
      selectRing,
      forgetRing,
      sync,
      scan,
      recordMotion,
      withRing,
      sendPending,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useAppState must be used inside AppProvider.');
  }
  return value;
}
