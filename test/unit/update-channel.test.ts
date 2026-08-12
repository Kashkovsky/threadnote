import {describe, expect, it} from 'vitest';
import {isBetaVersion, isPrereleaseVersion, selectUpdateChannel} from '../../src/update_channel.js';

describe('update channel inference', () => {
  it('infers the inclusive preview channel for any valid release prerelease', () => {
    for (const version of ['4.2.0-alpha.1', '4.2.0-beta.2', '4.2.0-rc.1']) {
      expect(isPrereleaseVersion(version)).toBe(true);
      expect(isBetaVersion(version)).toBe(true);
      expect(selectUpdateChannel(version)).toBe('beta');
    }
  });

  it('infers local development builds from their underlying release version', () => {
    const stableLocal = `4.2.0-local.g${'a'.repeat(40)}`;
    expect(isPrereleaseVersion(stableLocal)).toBe(false);
    expect(isBetaVersion(stableLocal)).toBe(false);
    expect(selectUpdateChannel(stableLocal)).toBe('latest');

    for (const version of [`4.2.0-beta.2.local.g${'a'.repeat(40)}`, `4.2.0-rc.1.local.g${'a'.repeat(64)}`]) {
      expect(isPrereleaseVersion(version)).toBe(true);
      expect(isBetaVersion(version)).toBe(true);
      expect(selectUpdateChannel(version)).toBe('beta');
    }
  });

  it('keeps stable inference and explicit channel overrides unchanged', () => {
    expect(selectUpdateChannel('4.2.0')).toBe('latest');
    expect(selectUpdateChannel('4.2.0', 'beta')).toBe('beta');
    expect(selectUpdateChannel('4.2.0-rc.1', 'latest')).toBe('latest');
  });
});
