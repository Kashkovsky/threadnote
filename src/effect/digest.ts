import {Crypto, Effect} from 'effect';

const textEncoder = new TextEncoder();

export const sha256Hex = Effect.fn('digest.sha256Hex')(function* (value: string | Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
  return bytesToHex(yield* crypto.digest('SHA-256', bytes));
});

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
