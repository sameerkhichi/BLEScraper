let tail: Promise<void> = Promise.resolve();
let queueTail: Promise<void> = Promise.resolve();
let depth = 0;
let pauses = 0;
const listeners = new Set<(busy: boolean) => void>();

function notify(): void {
  const busy = depth > 0;
  listeners.forEach((listener) => listener(busy));
}

export function subscribeRingBusy(listener: (busy: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pauseAutoSync(): () => void {
  pauses += 1;
  return () => {
    pauses = Math.max(0, pauses - 1);
  };
}

export function autoSyncPaused(): boolean {
  return pauses > 0;
}

// One ring operation at a time. A queued call waits until the current
// connection finishes so two reads cannot share the radio.
export function runWithRing<T>(action: () => Promise<T>): Promise<T> {
  const run = tail.then(async () => {
    depth += 1;
    notify();
    try {
      return await action();
    } finally {
      depth = Math.max(0, depth - 1);
      notify();
    }
  });
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function runWithQueue<T>(action: () => Promise<T>): Promise<T> {
  const run = queueTail.then(action, action);
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
