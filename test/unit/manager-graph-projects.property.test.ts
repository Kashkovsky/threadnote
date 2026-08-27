import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {Effect, Path} from 'effect';
import fc from 'fast-check';
import {expect} from 'vitest';
import {
  canonicalConfiguredProjectHasReadyGraph,
  foreignConfiguredProjectGraphState,
} from '../../src/manager_graph_projects.js';
import {managerProjectPathIsForeign} from '../../src/manager_project_roots.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const pathSegment = fc
  .string({minLength: 1, maxLength: 24, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_')})
  .filter(value => value !== '..');

effectIt.effect.prop(
  'recognizes only canonical descendants at a complete path boundary (property)',
  {segment: pathSegment},
  ({segment}) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const readyRoot = path.join(path.sep, 'repos', 'app');
      const nestedProject = path.join(readyRoot, 'packages', segment);
      const prefixSibling = `${readyRoot}-${segment}`;

      expect(canonicalConfiguredProjectHasReadyGraph(path, readyRoot, [readyRoot])).toBe(true);
      expect(canonicalConfiguredProjectHasReadyGraph(path, nestedProject, [readyRoot])).toBe(true);
      expect(canonicalConfiguredProjectHasReadyGraph(path, prefixSibling, [readyRoot])).toBe(false);
      expect(managerProjectPathIsForeign(`C:\\${segment}`, 'linux')).toBe(true);
      expect(managerProjectPathIsForeign(`C:/${segment}`, 'darwin')).toBe(true);
      expect(managerProjectPathIsForeign(`/${segment}`, 'win32')).toBe(true);
      expect(managerProjectPathIsForeign(`/${segment}`, 'linux')).toBe(false);
      expect(managerProjectPathIsForeign(`C:\\${segment}`, 'win32')).toBe(false);
      expect(foreignConfiguredProjectGraphState(`C:\\${segment}`, 'linux', false)).toBe('not-indexed');
      expect(foreignConfiguredProjectGraphState(`/${segment}`, 'win32', true)).toBe('unknown');
      expect(foreignConfiguredProjectGraphState(`/${segment}`, 'linux', false)).toBeUndefined();
    }).pipe(provideTestLayer(BunPath.layer)),
  {fastCheck: {numRuns: 64}},
);
