import {sha256HexSync} from '../crypto/sha256.js';

const MAXIMUM_CACHED_INPUT_CODE_UNITS = 64 * 1_024;

/** Cache only a pure digest; callers still rebuild and compare every contract input. */
export function createCachedCodeGraphContractHash(): (owner: object, input: string) => string {
  const cache = new WeakMap<object, {readonly input: string; readonly digest: string}>();
  return (owner, input) => {
    const previous = cache.get(owner);
    if (previous?.input === input) return previous.digest;
    const digest = sha256HexSync(input);
    if (input.length <= MAXIMUM_CACHED_INPUT_CODE_UNITS) cache.set(owner, {input, digest});
    else cache.delete(owner);
    return digest;
  };
}
