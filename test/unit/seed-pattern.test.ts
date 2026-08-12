import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  InvalidProjectSeedPattern,
  validateProjectSeedPattern,
  validateProjectSeedPatterns,
} from '../../src/seed_pattern.js';

const segment = FC.stringMatching(/^[a-z][a-z0-9._-]{0,20}$/u).filter(value => value !== '..');

describe('project seed pattern safety', () => {
  it.prop(
    'preserves bounded repository-relative patterns byte for byte',
    {
      glob: FC.constantFrom('', '/*', '/**/*.md'),
      segments: FC.array(segment, {maxLength: 8, minLength: 1}),
    },
    ({glob, segments}) => {
      const pattern = `${segments.join('/')}${glob}`;
      expect(validateProjectSeedPattern(pattern)).toBe(pattern);
    },
    {fastCheck: {numRuns: 200}},
  );

  it.prop(
    'rejects every generated parent traversal segment',
    {
      prefix: FC.array(segment, {maxLength: 5}),
      suffix: FC.array(segment, {maxLength: 5}),
    },
    ({prefix, suffix}) => {
      const pattern = [...prefix, '..', ...suffix].join('/');
      expect(() => validateProjectSeedPattern(pattern)).toThrow(InvalidProjectSeedPattern);
      expect(() => validateProjectSeedPattern(pattern.replaceAll('/', '\\'))).toThrow(InvalidProjectSeedPattern);
    },
    {fastCheck: {numRuns: 200}},
  );

  it('allows an empty project seed list but rejects rooted patterns', () => {
    expect(validateProjectSeedPatterns([])).toEqual([]);
    for (const pattern of ['/etc/passwd', '\\\\server\\share', 'C:\\Windows\\system.ini', '~/secrets']) {
      expect(() => validateProjectSeedPattern(pattern)).toThrow(InvalidProjectSeedPattern);
    }
  });
});
