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

export async function flushQueue(
  queue: PendingUpload[],
  post: (payload: UploadPayload) => Promise<void>,
): Promise<FlushResult> {
  const remaining = [...queue];
  let sent = 0;

  while (remaining.length > 0) {
    try {
      await post(remaining[0].payload);
      remaining.shift();
      sent += 1;
    } catch (error) {
      return {
        sent,
        remaining,
        error: error instanceof Error ? error.message : 'Upload failed.',
      };
    }
  }

  return { sent, remaining, error: null };
}
