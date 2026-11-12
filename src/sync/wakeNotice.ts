export type WakeWork = {
  downloadDays: number | null;
  waiting: number;
  sendsAfter: boolean;
};

export function wakeNoticeBody(work: WakeWork): string | null {
  const uploading =
    work.waiting > 0
      ? work.waiting === 1
        ? 'Uploading 1 waiting reading'
        : `Uploading ${work.waiting} waiting readings`
      : null;
  const days = work.downloadDays;
  if (!uploading && days == null) return null;
  if (uploading && days != null) {
    const after = work.sendsAfter ? ' Anything new is sent after the download.' : '';
    return `${uploading}, then downloading the last ${dayPhrase(days)} of heart rate, steps, and sleep from the ring.${after}`;
  }
  if (days != null && work.sendsAfter) {
    return `Downloading the last ${dayPhrase(days)} of heart rate, steps, and sleep from the ring, then sending anything new.`;
  }
  if (days != null) {
    return `Downloading the last ${dayPhrase(days)} of heart rate, steps, and sleep from the ring.`;
  }
  return `${uploading}.`;
}

function dayPhrase(days: number): string {
  if (days === 1) return 'day';
  return `${days} days`;
}
