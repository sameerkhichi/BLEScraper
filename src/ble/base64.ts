const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (first << 16) | (second << 8) | third;
    output += ALPHABET[(triple >> 18) & 63];
    output += ALPHABET[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? ALPHABET[triple & 63] : '=';
  }
  return output;
}

export function base64ToBytes(value: string): Uint8Array {
  const cleaned = value.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < cleaned.length; index += 4) {
    const first = ALPHABET.indexOf(cleaned[index] ?? 'A');
    const second = ALPHABET.indexOf(cleaned[index + 1] ?? 'A');
    const third = index + 2 < cleaned.length ? ALPHABET.indexOf(cleaned[index + 2]) : -1;
    const fourth = index + 3 < cleaned.length ? ALPHABET.indexOf(cleaned[index + 3]) : -1;
    const triple =
      (first << 18) | (second << 12) | ((third < 0 ? 0 : third) << 6) | (fourth < 0 ? 0 : fourth);
    bytes.push((triple >> 16) & 255);
    if (third >= 0) bytes.push((triple >> 8) & 255);
    if (fourth >= 0) bytes.push(triple & 255);
  }
  return Uint8Array.from(bytes);
}
