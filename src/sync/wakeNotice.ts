import type { WakeNotice } from '../model';

export type WakeOutcome = {
  downloaded: boolean;
  sent: number;
};

export function wakeNoticeBody(choice: WakeNotice, outcome: WakeOutcome): string | null {
  const downloaded = choice !== 'sent' && outcome.downloaded;
  const sent = choice !== 'download' && outcome.sent > 0 ? outcome.sent : 0;
  if (!downloaded && sent === 0) return null;
  if (downloaded && sent > 0) return `Downloaded the ring record and sent ${readingPhrase(sent)}.`;
  if (downloaded) return 'Downloaded the ring record.';
  return `Sent ${readingPhrase(sent)}.`;
}

function readingPhrase(count: number): string {
  return count === 1 ? '1 waiting reading' : `${count} waiting readings`;
}
