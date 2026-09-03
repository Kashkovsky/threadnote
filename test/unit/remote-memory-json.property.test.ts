import {describe, expect, it} from '@effect/vitest';
import {Predicate} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {isJsonObject, isJsonValue, requireJsonValue} from '../../src/remote_memory/json.js';

describe('remote memory JSON schema boundary', () => {
  it.prop(
    'accepts every JSON.parse round-trip and treats objects as JSON objects',
    {value: FC.jsonValue()},
    ({value}) => {
      const parsed: unknown = JSON.parse(JSON.stringify(value));
      expect(isJsonValue(parsed)).toBe(true);
      expect(requireJsonValue(parsed)).toEqual(parsed);
      expect(isJsonObject(parsed)).toBe(Predicate.isObject(parsed));
    },
    {fastCheck: {numRuns: 200}},
  );

  it('rejects values that JSON objects and Schema.Json do not admit', () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(1n)).toBe(false);
    expect(isJsonValue(() => undefined)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject('policy')).toBe(false);
    expect(() => requireJsonValue(undefined)).toThrow(TypeError);
  });
});
