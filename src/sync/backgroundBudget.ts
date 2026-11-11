let expired = false;

export function beginBackgroundAttempt(): void {
  expired = false;
}

export function noteBackgroundExpired(): void {
  expired = true;
}

export function backgroundExpired(): boolean {
  return expired;
}
