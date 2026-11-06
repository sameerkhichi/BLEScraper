import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { AppSettings, UploadPayload } from '../model';
import { enqueue, flushQueue, type PendingUpload } from '../sync/queue';
import {
  loadLastPayload,
  loadQueue,
  loadSettings,
  saveLastPayload,
  saveQueue,
  saveSettings,
} from '../sync/storage';
import { measureRing, syncRing } from '../sync/syncRing';
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
  sync: () => Promise<void>;
  measure: () => Promise<void>;
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

  const selectRing = useCallback(
    async (ringId: string, ringName: string | null) => {
      const next = { ...settings, ringId, ringName };
      setSettings(next);
      await saveSettings(next);
      setStatus(`Saved ${ringName || 'ring'}.`);
    },
    [settings],
  );

  const sync = useCallback(async () => {
    if (!settings.ringId) {
      setStatus('Choose the ring first.');
      return;
    }
    setBusy(true);
    try {
      const payload = await syncRing(settings.ringId, settings.ringName, setStatus);
      await remember(payload);
      const nextQueue = enqueue(queue, payload);
      await publishQueue(nextQueue);
      await sendQueue(nextQueue, settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  }, [publishQueue, queue, remember, sendQueue, settings]);

  const measure = useCallback(async () => {
    if (!settings.ringId) {
      setStatus('Choose the ring first.');
      return;
    }
    setBusy(true);
    try {
      const payload = await measureRing(settings.ringId, settings.ringName, setStatus);
      await remember(payload);
      if (payload.realtimeHeartRate === null) {
        setStatus(payload.warnings[0] ?? 'No live heart-rate reading.');
        return;
      }
      const nextQueue = enqueue(queue, payload);
      await publishQueue(nextQueue);
      await sendQueue(nextQueue, settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Measurement failed.');
    } finally {
      setBusy(false);
    }
  }, [publishQueue, queue, remember, sendQueue, settings]);

  const sendPending = useCallback(async () => {
    setBusy(true);
    try {
      await sendQueue(queue, settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Upload failed.');
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
      sync,
      measure,
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
      sync,
      measure,
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
