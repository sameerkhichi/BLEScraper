import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { closeRing, openRing } from '../ble/ringClient';
import { describeAutomaticChecks } from '../ble/protocol';
import { debugLog, flushDebugLog, hydrateDebugLog } from '../ble/debugLog';
import { getBleManager } from '../ble/manager';
import { keepSleepRecord, keepStoredSamples, mergeReadings, defaultSettings, type AccelSample, type AppSettings, type ScanKind, type UploadPayload } from '../model';
import { markRingAsleep, markSyncCompleted, markUploadAttempted, runAutoSync, setAutoSyncStatusSink, setSyncSnapshotSink } from '../sync/autoSync';
import { syncBackgroundRegistration } from '../sync/backgroundSync';
import { ensureNotificationPermission, reportBattery } from '../sync/notifyBattery';
import { enqueue, flushQueue, forgetDropped, markDropped, removeFromQueue, type PendingUpload } from '../sync/queue';
import { ringBusy, runWithQueue, runWithRing, subscribeRingBusy } from '../sync/ringGate';
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
  recordHeartRate: (bpm: number) => Promise<void>;
  withRing: <T>(action: () => Promise<T>) => Promise<T>;
  sendPending: () => Promise<void>;
  removePending: (id: string) => Promise<void>;
  clearPending: () => Promise<void>;
  applyRingChecks: () => Promise<string>;
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

  // Callers already hold runWithQueue. Taking it again would wait on this send.
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
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') void flushDebugLog();
    });
    return () => subscription.remove();
  }, []);
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
        hydrateDebugLog(),
      ]);
      if (cancelled) return;
      setSettings(storedSettings);
      setQueue(storedQueue);
      setLastPayload(storedLast);
      try {
        await ensureNotificationPermission(true);
        if (!cancelled) await reportBattery(storedLast?.battery ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not ask for notifications.';
        debugLog(message);
      }
      if (cancelled) return;
      setReady(true);
      const upload = evaluateUpload(syncState.uploadAt, storedQueue.length, Date.now());
      if (storedSettings.apiUrl.trim() && upload.due) {
        await runWithRing(() =>
          runWithQueue(async () => {
            await sendQueue(await loadQueue(), storedSettings);
          }),
        );
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

  const applyRingChecks = useCallback(async (): Promise<string> => {
    const stored = await loadSettings();
    if (!stored.ringId) return 'Choose a ring before applying checks.';
    return withRing(async () => {
      setStatus('Writing the ring checks');
      const client = await openRing(stored.ringId as string);
      const report = await client.applyAutomaticChecks(stored.ringChecks);
      const message = describeAutomaticChecks(report);
      setStatus(message);
      return message;
    });
  }, [withRing]);

  const saveAppSettings = useCallback(
    async (next: AppSettings) => {
      setSettings(next);
      await saveSettings(next);
      await runWithQueue(async () => {
        const storedQueue = await loadQueue();
        if (storedQueue.length > 0) {
          await sendQueue(storedQueue, next);
        } else {
          setStatus('Settings saved.');
        }
      });
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
        const collected = await syncRing(stored.ringId, stored.ringName, setStatus, stored.ringChecks);
        await closeRing();
        if (!collected.worn) {
          if (!collected.sleepLoaded) {
            await markRingAsleep();
            setStatus(collected.payload.warnings[0] ?? 'Ring is not being worn. Leaving it asleep.');
            return;
          }
          const storedSleep = keepStoredSamples(previous, keepSleepRecord(previous, collected.payload));
          await remember(storedSleep);
          await runWithQueue(async () => {
            const nextQueue = enqueue(await loadQueue(), storedSleep);
            await publishQueue(nextQueue);
            await sendQueue(nextQueue, stored);
          });
          await markSyncCompleted({ sleep: true });
          await markRingAsleep();
          return;
        }
        const payload =
          collected.sleepLoaded || !previous
            ? collected.payload
            : { ...collected.payload, sleep: previous.sleep };
        const merged = keepStoredSamples(previous, mergeReadings(previous, payload, false));
        await remember(merged);
        await runWithQueue(async () => {
          const nextQueue = enqueue(await loadQueue(), payload);
          await publishQueue(nextQueue);
          await sendQueue(nextQueue, stored);
        });
        await markSyncCompleted({ logs: true, sleep: collected.sleepLoaded });
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
        await runWithQueue(async () => {
          const nextQueue = enqueue(await loadQueue(), payload);
          await publishQueue(nextQueue);
          await sendQueue(nextQueue, stored);
        });
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

  const recordHeartRate = useCallback(async (bpm: number) => {
    await runWithQueue(async () => {
      const stored = await loadSettings();
      if (!stored.ringId) {
        setStatus('Choose the ring first.');
        return;
      }
      const previous = await loadLastPayload();
      const storedQueue = await loadQueue();
      const payload = readingPayload(stored.ringId, stored.ringName, { realtimeHeartRate: bpm });
      await remember(mergeReadings(previous, payload, true));
      const nextQueue = enqueue(storedQueue, payload);
      await publishQueue(nextQueue);
      await sendQueue(nextQueue, stored);
    });
  }, [publishQueue, remember, sendQueue]);

  const sendPending = useCallback(async () => {
    await runWithRing(async () => {
      try {
        await runWithQueue(async () => {
          const stored = await loadSettings();
          await sendQueue(await loadQueue(), stored);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Upload failed.';
        debugLog(message);
        setStatus(message);
      }
    });
  }, [sendQueue]);

  const removePending = useCallback(
    async (id: string) => {
      markDropped(id);
      setQueue((current) => removeFromQueue(current, id));
      await runWithQueue(async () => {
        try {
          const storedQueue = await loadQueue();
          const nextQueue = removeFromQueue(storedQueue, id);
          if (nextQueue.length !== storedQueue.length) {
            await publishQueue(nextQueue);
            if (!ringBusy()) {
              setStatus(
                nextQueue.length === 0
                  ? 'Nothing waiting to send.'
                  : `${nextQueue.length} reading${nextQueue.length === 1 ? '' : 's'} waiting.`,
              );
            }
          }
        } finally {
          forgetDropped(id);
        }
      });
    },
    [publishQueue],
  );

  const clearPending = useCallback(async () => {
    const ids = (await loadQueue()).map((item) => item.id);
    if (ids.length === 0) return;
    for (const id of ids) markDropped(id);
    setQueue((current) => current.filter((item) => !ids.includes(item.id)));
    await runWithQueue(async () => {
      try {
        const nextQueue = (await loadQueue()).filter((item) => !ids.includes(item.id));
        await publishQueue(nextQueue);
        if (!ringBusy()) {
          setStatus(
            nextQueue.length === 0
              ? 'Nothing waiting to send.'
              : `${nextQueue.length} reading${nextQueue.length === 1 ? '' : 's'} waiting.`,
          );
        }
      } finally {
        for (const id of ids) forgetDropped(id);
      }
    });
  }, [publishQueue]);

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
      recordHeartRate,
      withRing,
      sendPending,
      removePending,
      clearPending,
      applyRingChecks,
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
      recordHeartRate,
      withRing,
      sendPending,
      removePending,
      clearPending,
      applyRingChecks,
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
