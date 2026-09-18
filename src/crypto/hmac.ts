export function hmacSha256Hex(keyHex: string, message: string): string {
  if (!/^[0-9a-f]{64}$/u.test(keyHex)) throw new Error('HMAC key must be a 256-bit lowercase hex value.');
  return new Bun.CryptoHasher('sha256', fromHex(keyHex)).update(message).digest('hex');
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from({length: value.length / 2}, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}
