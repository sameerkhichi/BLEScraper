import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { closeRing } from '../ble/ringClient';
import { debugLog } from '../ble/debugLog';
import { getBleManager } from '../ble/manager';
import { mergeReadings, defaultSettings, type AccelSample, type AppSettings, type ScanKind, type UploadPayload } from '../model';
import { markRingAsleep, markSyncCompleted, markUploadAttempted, runAutoSync, setAutoSyncStatusSink, setSyncSnapshotSink } from '../sync/autoSync';
import { syncBackgroundRegistration } from '../sync/backgroundSync';
import { enqueue, flushQueue, type PendingUpload } from '../sync/queue';
import { runWithQueue, runWithRing, subscribeRingBusy } from '../sync/ringGate';
import { evaluateUpload } from '../sync/schedule';
import {
  loadAutoSyncState,
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
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [queue, setQueue] = useState<PendingUpload[]>([]);
  const [lastPayload, setLastPayload] = useState<UploadPayload | null>(null);

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
      if (nextQueue.length === 0) {
        setStatus('Nothing waiting to send.');
        return;
      }
      setStatus('Sending to the API');
      await markUploadAttempted();
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

  const remember = useCallback(async (payload: UploadPayload) => {
    setLastPayload(payload);
    await saveLastPayload(payload);
  }, []);

  useEffect(() => setAutoSyncStatusSink(setStatus), []);
  useEffect(
    () =>
      setSyncSnapshotSink((snapshot) => {
        setQueue(snapshot.queue);
        setLastPayload(snapshot.lastPayload);
      }),
    [],
  );
  useEffect(() => subscribeRingBusy(setBusy), []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [storedSettings, storedQueue, storedLast, syncState] = await Promise.all([
        loadSettings(),
        loadQueue(),
        loadLastPayload(),
        loadAutoSyncState(),
      ]);
      if (cancelled) return;
      setSettings(storedSettings);
      setQueue(storedQueue);
      setLastPayload(storedLast);
      setReady(true);
      const upload = evaluateUpload(syncState.uploadAt, storedQueue.length, Date.now());
      if (storedSettings.apiUrl.trim() && upload.due) {
        await runWithRing(() => sendQueue(storedQueue, storedSettings));
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

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let appActive = AppState.currentState === 'active';
    const enabled = settings.autoSync && Boolean(settings.ringId);

    const arm = (waitMs: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void tick(appActive);
      }, Math.max(waitMs, 1000));
    };

    const tick = async (allowAndroidService: boolean) => {
      if (cancelled) return;
      const result = await runAutoSync({ allowAndroidService });
      if (cancelled) return;
      if (result.message) setStatus(result.message);
      arm(result.waitMs);
    };

    void syncBackgroundRegistration(enabled);
    if (!enabled) {
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }

    const subscription = AppState.addEventListener('change', (next) => {
      const wasActive = appActive;
      appActive = next === 'active';
      if (next === 'active' || next === 'inactive' || next === 'background') {
        void tick(wasActive || next === 'active');
      }
    });
    arm(1000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [ready, settings.autoSync, settings.ringId]);

  const withRing = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    return runWithRing(async () => {
      try {
        return await action();
      } finally {
        await closeRing();
      }
    });
  }, []);

  const saveAppSettings = useCallback(
    async (next: AppSettings) => {
      setSettings(next);
      await saveSettings(next);
      const storedQueue = await loadQueue();
      if (storedQueue.length > 0) {
        await sendQueue(storedQueue, next);
      } else {
        setStatus('Settings saved.');
      }
    },
    [sendQueue],
  );

  const releaseRing = useCallback(async (ringId: string | null) => {
    if (!ringId) return;
    if (await closeRing(ringId)) return;
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
      await runWithRing(async () => {
        const stored = await loadSettings();
        const previous = stored.ringId;
        const next = { ...stored, ringId, ringName };
        setSettings(next);
        await saveSettings(next);
        if (previous && previous !== ringId) await releaseRing(previous);
        setStatus(`Saved ${ringName || 'ring'}.`);
        debugLog(`Selected ${ringName || ringId}`);
      });
    },
    [releaseRing],
  );

  const forgetRing = useCallback(async () => {
    await runWithRing(async () => {
      const stored = await loadSettings();
      const next = { ...stored, ringId: null, ringName: null };
      setSettings(next);
      await saveSettings(next);
      await releaseRing(stored.ringId);
      setStatus('Disconnected.');
      debugLog('Forgot the selected ring');
    });
  }, [releaseRing]);

  const sync = useCallback(async () => {
    await withRing(async () => {
      const stored = await loadSettings();
      if (!stored.ringId) {
        setStatus('Choose the ring first.');
        return;
      }
      try {
        const previous = await loadLastPayload();
        const storedQueue = await loadQueue();
        const collected = await syncRing(stored.ringId, stored.ringName, setStatus);
        await closeRing();
        if (!collected.worn) {
          await markRingAsleep();
          setStatus(collected.payload.warnings[0] ?? 'Ring is not being worn. Leaving it asleep.');
          return;
        }
        const payload =
          collected.sleepLoaded || !previous
            ? collected.payload
            : { ...collected.payload, sleep: previous.sleep };
        const merged = mergeReadings(previous, payload, false);
        await remember(merged);
        const nextQueue = enqueue(storedQueue, payload);
        await publishQueue(nextQueue);
        await sendQueue(nextQueue, stored);
        await markSyncCompleted({ logs: true, sleep: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Sync failed.';
        debugLog(message);
        setStatus(message);
      }
    });
  }, [publishQueue, remember, sendQueue, withRing]);

  const scan = useCallback(async (kind: ScanKind) => {
    await withRing(async () => {
      const stored = await loadSettings();
      if (!stored.ringId) {
        setStatus('Choose the ring first.');
        return;
      }
      try {
        const previous = await loadLastPayload();
        const storedQueue = await loadQueue();
        const reading = await scanRing(stored.ringId, stored.ringName, kind, setStatus);
        await closeRing();
        if (!reading.worn) {
          await markRingAsleep();
          setStatus(reading.payload.warnings[0] ?? 'Ring is not being worn. Leaving it asleep.');
          return;
        }
        const payload = reading.payload;
        const succeeded =
          payload.realtimeHeartRate !== null || payload.spo2 !== null || payload.bodyTemperatureC !== null;
        if (!succeeded) {
          setStatus(payload.warnings.join(' ') || 'The ring did not return a reading.');
          return;
        }
        await remember(mergeReadings(previous, payload, true));
        const nextQueue = enqueue(storedQueue, payload);
        await publishQueue(nextQueue);
        await sendQueue(nextQueue, stored);
        await markSyncCompleted({ vitals: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Measurement failed.';
        debugLog(message);
        setStatus(message);
      }
    });
  }, [publishQueue, remember, sendQueue, withRing]);

  const recordMotion = useCallback(async (sample: AccelSample) => {
    await runWithQueue(async () => {
      const stored = await loadSettings();
      if (!stored.ringId) {
        setStatus('Choose the ring first.');
        return;
      }
      const previous = await loadLastPayload();
      const storedQueue = await loadQueue();
      const payload = readingPayload(stored.ringId, stored.ringName, { accelerometer: sample });
      await remember(mergeReadings(previous, payload, true));
      const nextQueue = enqueue(storedQueue, payload);
      await publishQueue(nextQueue);
      await sendQueue(nextQueue, stored);
    });
  }, [publishQueue, remember, sendQueue]);

  const sendPending = useCallback(async () => {
    await runWithRing(async () => {
      try {
        const stored = await loadSettings();
        await sendQueue(await loadQueue(), stored);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Upload failed.';
        debugLog(message);
        setStatus(message);
      }
    });
  }, [sendQueue]);

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
