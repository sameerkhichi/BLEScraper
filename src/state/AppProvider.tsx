import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { closeRing, openRing } from '../ble/ringClient';
import {
  describeFirmware,
  emptyPending,
  settingMatches,
  type FirmwareRead,
  type ParsedSetting,
  type SettingField,
  type SettingPatch,
} from '../ble/ringSettings';
import { debugLog, flushDebugLog, hydrateDebugLog } from '../ble/debugLog';
import { clearRingServices, hydrateRingServices } from '../ble/ringServices';
import { getBleManager } from '../ble/manager';
import {
  clearPendingField,
  keepSleepRecord,
  keepStoredSamples,
  mergeFirmwareRead,
  mergeReadings,
  shownChecks,
  shownGesture,
  stageFirmwareChange,
  defaultSettings,
  type AccelSample,
  type AppSettings,
  type ScanKind,
  type UploadPayload,
} from '../model';
import { markRingAsleep, markSyncCompleted, markUploadAttempted, runAutoSync, setAutoSyncStatusSink, setSyncSnapshotSink } from '../sync/autoSync';
import { syncBackgroundRegistration } from '../sync/backgroundSync';
import { hydrateBackgroundWake } from '../sync/wakeLog';
import { ensureNotificationPermission, reportBattery, reportTemperature } from '../sync/notifyBattery';
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
  recordStress: (value: number) => Promise<void>;
  withRing: <T>(action: () => Promise<T>) => Promise<T>;
  sendPending: () => Promise<void>;
  removePending: (id: string) => Promise<void>;
  clearPending: () => Promise<void>;
  readRingFirmware: () => Promise<string>;
  writeRingField: (field: SettingField, patch: SettingPatch) => Promise<string>;
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
        hydrateRingServices(),
        hydrateBackgroundWake(),
      ]);
      if (cancelled) return;
      setSettings(storedSettings);
      setQueue(storedQueue);
      setLastPayload(storedLast);
      try {
        await ensureNotificationPermission(true);
        if (!cancelled) {
          await reportBattery(storedLast?.battery ?? null);
          await reportTemperature(storedLast?.bodyTemperatureC ?? null);
        }
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

  const rememberFirmware = useCallback(async (read: FirmwareRead) => {
    const latest = await loadSettings();
    const next = mergeFirmwareRead(latest, read);
    setSettings(next);
    await saveSettings(next);
    const message = describeFirmware(read);
    setStatus(message);
    return message;
  }, []);

  const pullFirmware = useCallback(
    async (ringId: string): Promise<string> => {
      setStatus('Reading the ring settings');
      const client = await openRing(ringId);
      const read = await client.readFirmware();
      return rememberFirmware(read);
    },
    [rememberFirmware],
  );

  const readRingFirmware = useCallback(async (): Promise<string> => {
    const stored = await loadSettings();
    if (!stored.ringId) return 'Choose a ring to read its settings.';
    return withRing(() => pullFirmware(stored.ringId as string));
  }, [pullFirmware, withRing]);

  const writeRingField = useCallback(
    async (field: SettingField, patch: SettingPatch): Promise<string> => {
      try {
        return await withRing(async () => {
          const latest = await loadSettings();
          const optimistic = stageFirmwareChange(latest, field, patch);
          setSettings(optimistic);
          await saveSettings(optimistic);
          if (!latest.ringId) {
            return 'Saved on the phone. It is written when the ring is in range and you write the change.';
          }
          try {
            setStatus('Writing the ring setting');
            const client = await openRing(latest.ringId);
            const read = await client.writeFirmwareField(optimistic.firmware, field, patch);
            const saved = await loadSettings();
            const echoed = settingOf(read, field);
            const accepted = echoed !== null && settingMatches(echoed, patch);
            const next = {
              ...mergeFirmwareRead(saved, read),
              pendingFirmware: accepted ? clearPendingField(saved.pendingFirmware, field) : saved.pendingFirmware,
            };
            setSettings(next);
            await saveSettings(next);
            const message = describeFirmware(read);
            setStatus(message);
            return message;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'The ring did not answer.';
            return `${message} Saved on the phone until the ring is in range.`;
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The ring did not answer.';
        return `${message} Saved on the phone until the ring is in range.`;
      }
    },
    [withRing],
  );

  const applyRingChecks = useCallback(async (): Promise<string> => {
    const stored = await loadSettings();
    if (!stored.ringId) return 'Choose a ring before writing settings.';
    return withRing(async () => {
      const latest = await loadSettings();
      setStatus('Writing the ring settings');
      const client = await openRing(latest.ringId as string);
      let read = await client.readFirmware();
      for (const field of pendingFields(latest)) {
        read = await client.writeFirmwareField(read, field, patchFor(latest, field));
      }
      const next = { ...mergeFirmwareRead(latest, read), pendingFirmware: emptyPending() };
      setSettings(next);
      await saveSettings(next);
      const message = describeFirmware(read);
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
        if (previous && previous !== ringId) {
          await releaseRing(previous);
          clearRingServices();
        }
        try {
          const message = await pullFirmware(ringId);
          debugLog(`Selected ${ringName || ringId}. ${message}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The ring settings were not read.';
          setStatus(`Saved ${ringName || 'ring'}. ${message}`);
          debugLog(`Selected ${ringName || ringId}. ${message}`);
        } finally {
          await closeRing();
        }
      });
    },
    [pullFirmware, releaseRing],
  );

  const forgetRing = useCallback(async () => {
    await runWithRing(async () => {
      const stored = await loadSettings();
      const next = { ...stored, ringId: null, ringName: null };
      setSettings(next);
      await saveSettings(next);
      await releaseRing(stored.ringId);
      clearRingServices();
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
        const collected = await syncRing(stored.ringId, stored.ringName, setStatus);
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

  const recordStress = useCallback(async (value: number) => {
    await runWithQueue(async () => {
      const stored = await loadSettings();
      if (!stored.ringId) {
        setStatus('Choose the ring first.');
        return;
      }
      const previous = await loadLastPayload();
      const storedQueue = await loadQueue();
      const payload = readingPayload(stored.ringId, stored.ringName, {
        stress: [{ timestamp: new Date().toISOString(), value }],
      });
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
      recordStress,
      withRing,
      sendPending,
      removePending,
      clearPending,
      readRingFirmware,
      writeRingField,
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
      recordStress,
      withRing,
      sendPending,
      removePending,
      clearPending,
      readRingFirmware,
      writeRingField,
      applyRingChecks,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function pendingFields(settings: AppSettings): SettingField[] {
  const pending = settings.pendingFirmware;
  const fields: SettingField[] = [];
  if (pending.heartRate !== null || pending.heartRateMinutes !== null) fields.push('heartRate');
  if (pending.spo2 !== null) fields.push('spo2');
  if (pending.stress !== null) fields.push('stress');
  if (pending.hrv !== null) fields.push('hrv');
  if (pending.gesture !== null) fields.push('gesture');
  return fields;
}

function settingOf(read: FirmwareRead, field: SettingField): ParsedSetting | null {
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

function patchFor(settings: AppSettings, field: SettingField): SettingPatch {
  const checks = shownChecks(settings);
  if (field === 'heartRate') return { enabled: checks.heartRate, minutes: checks.heartRateMinutes };
  if (field === 'gesture') return { enabled: shownGesture(settings) ?? false };
  return { enabled: checks[field] };
}

export function useAppState(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useAppState must be used inside AppProvider.');
  }
  return value;
}
