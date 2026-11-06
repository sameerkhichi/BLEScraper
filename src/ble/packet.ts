export const PACKET_LENGTH = 16;

export function checksum(packet: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < PACKET_LENGTH - 1; index += 1) {
    sum += packet[index] ?? 0;
  }
  return sum & 0xff;
}

export function isValidPacket(packet: Uint8Array): boolean {
  return packet.length >= PACKET_LENGTH && checksum(packet) === packet[PACKET_LENGTH - 1];
}

export function makePacket(command: number, subData: number[] = []): Uint8Array {
  if (!Number.isInteger(command) || command < 0 || command > 255) {
    throw new Error('Command must be a byte.');
  }
  if (subData.length > 14) {
    throw new Error('Packet data must be 14 bytes or fewer.');
  }

  const packet = new Uint8Array(PACKET_LENGTH);
  packet[0] = command;
  subData.forEach((value, index) => {
    packet[index + 1] = value & 0xff;
  });
  packet[PACKET_LENGTH - 1] = checksum(packet);
  return packet;
}

export function byteToBcd(value: number): number {
  return ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff;
}

export function bcdToDecimal(value: number): number {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
}

export function readInt32LE(packet: Uint8Array, offset: number): number {
  return (
    (packet[offset] |
      (packet[offset + 1] << 8) |
      (packet[offset + 2] << 16) |
      (packet[offset + 3] << 24)) |
    0
  );
}

export function writeInt32LE(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}
