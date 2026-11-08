import type { UploadPayload } from '../model';

export type PendingUpload = {
  id: string;
  createdAt: string;
  payload: UploadPayload;
};

export type FlushResult = {
  sent: number;
  remaining: PendingUpload[];
  error: string | null;
};

// Ids removed while a send is already running. flushQueue checks this before each post.
const droppedIds = new Set<string>();

export function markDropped(id: string): void {
  droppedIds.add(id);
}

export function forgetDropped(id: string): void {
  droppedIds.delete(id);
}

function withoutDropped(queue: PendingUpload[]): PendingUpload[] {
  if (droppedIds.size === 0) return queue;
  return queue.filter((item) => !droppedIds.has(item.id));
}

export function enqueue(
  queue: PendingUpload[],
  payload: UploadPayload,
  now = new Date(),
): PendingUpload[] {
  return [
    ...queue,
    {
      id: `${now.getTime()}-${queue.length}`,
      createdAt: now.toISOString(),
      payload,
    },
  ];
}

export function removeFromQueue(queue: PendingUpload[], id: string): PendingUpload[] {
  return queue.filter((item) => item.id !== id);
}

export async function flushQueue(
  queue: PendingUpload[],
  post: (payload: UploadPayload) => Promise<void>,
): Promise<FlushResult> {
  const remaining = [...queue];
  let sent = 0;

  while (remaining.length > 0) {
    if (droppedIds.has(remaining[0].id)) {
      remaining.shift();
      continue;
    }
    try {
      await post(remaining[0].payload);
      remaining.shift();
      sent += 1;
    } catch (error) {
      return {
        sent,
        remaining: withoutDropped(remaining),
        error: error instanceof Error ? error.message : 'Upload failed.',
      };
    }
  }

  return { sent, remaining: withoutDropped(remaining), error: null };
}
