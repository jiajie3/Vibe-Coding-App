/**
 * UUIDv7 — time-ordered identifiers.
 *
 * The contract requires client-generated IDs (§1.1) so that photos and checklist
 * answers can reference an inspection created while offline, before the server
 * has ever heard of it. v7 rather than v4 because the leading 48 bits are a
 * millisecond timestamp, so IDs sort by creation time and FRCDE's indexes stay
 * sane instead of fragmenting on random inserts.
 *
 * Uses Math.random for the entropy bits. Fine for a mockup; swap for
 * expo-crypto's getRandomBytes before anything ships, since these IDs end up in
 * URLs and a guessable ID is an enumeration vector.
 */

const HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);

  // 48-bit big-endian millisecond timestamp.
  b[0] = (now / 2 ** 40) & 0xff;
  b[1] = (now / 2 ** 32) & 0xff;
  b[2] = (now / 2 ** 24) & 0xff;
  b[3] = (now / 2 ** 16) & 0xff;
  b[4] = (now / 2 ** 8) & 0xff;
  b[5] = now & 0xff;

  for (let i = 6; i < 16; i++) b[i] = (Math.random() * 256) & 0xff;

  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant

  const h = HEX;
  return (
    h[b[0]] + h[b[1]] + h[b[2]] + h[b[3]] + '-' +
    h[b[4]] + h[b[5]] + '-' +
    h[b[6]] + h[b[7]] + '-' +
    h[b[8]] + h[b[9]] + '-' +
    h[b[10]] + h[b[11]] + h[b[12]] + h[b[13]] + h[b[14]] + h[b[15]]
  );
}
