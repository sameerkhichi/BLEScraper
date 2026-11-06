import type { SleepCycle, SleepNight, SleepStage, SleepStageName } from '../model';

export const BIG_DATA_SERVICE_UUID = 'DE5BF728-D711-4E47-AF26-65E3012A5DC7';
export const BIG_DATA_RX_UUID = 'DE5BF72A-D711-4E47-AF26-65E3012A5DC7';
export const BIG_DATA_TX_UUID = 'DE5BF729-D711-4E47-AF26-65E3012A5DC7';

const BIG_DATA_MAGIC = 0xbc;
const BIG_DATA_SLEEP = 0x27;
const MAX_PACKET_BYTES = 4096;

const STAGE_NAMES: Record<number, SleepStageName> = {
  2: 'light',
  3: 'deep',
  4: 'rem',
  5: 'awake',
};

// Working rings answer this 7-byte request. The length byte is 1, not the empty-payload form.
export function sleepRequestPacket(): Uint8Array {
  return Uint8Array.of(BIG_DATA_MAGIC, BIG_DATA_SLEEP, 0x01, 0x00, 0xff, 0x00, 0xff);
}

export class BigDataAssembler {
  private parts: Uint8Array[] = [];
  private expected: number | null = null;

  push(chunk: Uint8Array): Uint8Array | null {
    if (this.expected === null) {
      if (chunk.length < 6 || chunk[0] !== BIG_DATA_MAGIC) return null;
      const length = chunk[2] | (chunk[3] << 8);
      if (length > MAX_PACKET_BYTES) {
        throw new Error('Sleep packet was larger than expected.');
      }
      this.expected = length + 6;
    }

    this.parts.push(chunk);
    const total = this.parts.reduce((sum, part) => sum + part.length, 0);
    if (total < this.expected) return null;

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return merged.subarray(0, this.expected);
  }
}

// Minutes are after midnight of the wake-up day. A start later than the end began the evening before.
export function parseSleepPacket(packet: Uint8Array, now: Date): SleepNight[] {
  if (packet.length < 6 || packet[0] !== BIG_DATA_MAGIC || packet[1] !== BIG_DATA_SLEEP) {
    throw new Error('Sleep packet was not a sleep record.');
  }

  const packetLength = packet[2] | (packet[3] << 8);
  if (packetLength < 2 || packet.length < 7) return [];

  const payload = packet.subarray(6, 6 + packetLength);
  const dayCount = payload[0] ?? 0;
  const nights: SleepNight[] = [];
  let offset = 1;

  for (let day = 0; day < dayCount; day += 1) {
    if (offset + 2 > payload.length) break;
    const daysAgo = payload[offset] ?? 0;
    const dayBytes = payload[offset + 1] ?? 0;
    offset += 2;
    if (dayBytes < 4 || offset + dayBytes > payload.length) break;

    const body = payload.subarray(offset, offset + dayBytes);
    offset += dayBytes;
    const night = parseNight(body, daysAgo, now);
    if (night) nights.push(night);
  }

  nights.sort((left, right) => left.daysAgo - right.daysAgo);
  return nights;
}

function parseNight(body: Uint8Array, daysAgo: number, now: Date): SleepNight | null {
  const sleepStart = body[0] | (body[1] << 8);
  const sleepEnd = body[2] | (body[3] << 8);
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo);
  const startedAtMs = anchor + (sleepStart > sleepEnd ? sleepStart - 1440 : sleepStart) * 60 * 1000;
  const endedAtMs = anchor + sleepEnd * 60 * 1000;
  if (endedAtMs < startedAtMs) return null;

  const stages: SleepStage[] = [];
  let cursor = startedAtMs;
  for (let index = 4; index + 1 < body.length; index += 2) {
    const minutes = body[index + 1] ?? 0;
    if (minutes === 0) continue;
    const stage = STAGE_NAMES[body[index] ?? 0] ?? 'unknown';
    stages.push({
      stage,
      minutes,
      startedAt: new Date(cursor).toISOString(),
    });
    cursor += minutes * 60 * 1000;
  }

  const minutesLight = total(stages, 'light');
  const minutesDeep = total(stages, 'deep');
  const minutesRem = total(stages, 'rem');
  const minutesAwake = total(stages, 'awake');
  const minutesUnknown = total(stages, 'unknown');

  return {
    daysAgo,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    minutesAsleep: minutesLight + minutesDeep + minutesRem,
    minutesInBed: Math.round((endedAtMs - startedAtMs) / 60000),
    minutesLight,
    minutesDeep,
    minutesRem,
    minutesAwake,
    minutesUnknown,
    awakenings: stages.filter((stage) => stage.stage === 'awake').length,
    stages,
    cycles: buildCycles(stages),
  };
}

function total(stages: SleepStage[], name: SleepStageName): number {
  return stages.reduce((sum, stage) => (stage.stage === name ? sum + stage.minutes : sum), 0);
}

// The ring stores stages, not cycle numbers. A cycle runs through the next REM block.
function buildCycles(stages: SleepStage[]): SleepCycle[] {
  const cycles: SleepCycle[] = [];
  let current: SleepStage[] = [];

  const close = (complete: boolean) => {
    if (current.length === 0) return;
    const last = current[current.length - 1];
    const endMs = new Date(last.startedAt).getTime() + last.minutes * 60 * 1000;
    cycles.push({
      index: cycles.length + 1,
      startedAt: current[0].startedAt,
      endedAt: new Date(endMs).toISOString(),
      minutes: current.reduce((sum, stage) => sum + stage.minutes, 0),
      complete,
    });
    current = [];
  };

  for (const stage of stages) {
    current.push(stage);
    if (stage.stage === 'rem') close(true);
  }
  close(false);
  return cycles;
}
