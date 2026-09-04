import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {randomUuidV4} from '../../src/crypto/uuid.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('randomUuidV4', () => {
  it.prop('encodes version 4 and RFC 4122 variant bits', {sample: FC.nat()}, () => {
    expect(randomUuidV4()).toMatch(UUID_V4);
  });
});
