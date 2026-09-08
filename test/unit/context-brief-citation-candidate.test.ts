import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {readContextBriefCitationScaleCandidate} from '../../scripts/benchmark-context-brief-citations-target.js';
import {CommandExecutor, runCommandEffect} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';
import {
  contextBriefCitationScaleCandidateBinding,
  contextBriefCitationScaleReleaseIdentityFailures,
  type ContextBriefCitationScaleReleaseIdentityV1,
} from '../../src/evaluation/context-brief-citation-scale-contract.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const COMMIT = 'a'.repeat(40);
const identity: ContextBriefCitationScaleReleaseIdentityV1 = {
  architecture: 'arm64',
  candidateCommit: COMMIT,
  commit: COMMIT,
  cpu: 'Apple M1 (Virtual)',
  dirty: false,
  gitStatusObserved: true,
  githubActions: true,
  operatingSystem: 'macOS 15.6.1',
  runnerArchitecture: 'ARM64',
  runnerClass: 'github-hosted-macos-15-ARM64',
  runnerEnvironment: 'github-hosted',
  runnerOperatingSystem: 'macOS',
  runtime: 'bun/1.3.14',
  sourceVersion: 'threadnote-4.6.0',
};
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(SystemInfo.layer));
const candidateLayer = commandLayer.pipe(Layer.provideMerge(BunServices.layer));

describe('Context Brief release candidate version binding', () => {
  it('retains historical 4.6.0 validation and requires external binding for later versions', () => {
    expect(contextBriefCitationScaleReleaseIdentityFailures(identity)).toEqual([]);
    const current = {...identity, sourceVersion: 'threadnote-4.6.8'};
    expect(contextBriefCitationScaleReleaseIdentityFailures(current)).toContain(
      'source version threadnote-4.6.8; required threadnote-4.6.0',
    );
    expect(
      contextBriefCitationScaleReleaseIdentityFailures(
        current,
        contextBriefCitationScaleCandidateBinding(COMMIT, {version: '4.6.8'}),
      ),
    ).toEqual([]);
  });

  it('rejects malformed package versions and directly constructed malformed bindings', () => {
    for (const manifest of [
      null,
      {},
      {version: ''},
      {version: 4.6},
      {version: 'latest'},
      {version: '04.6.8'},
      {version: '4.6.8-..'},
      {version: '4.6.8+.'},
      {version: '4.6.8-01'},
      {version: '4.6.8-rc..1'},
    ]) {
      expect(() => contextBriefCitationScaleCandidateBinding(COMMIT, manifest)).toThrow();
    }
    expect(
      contextBriefCitationScaleReleaseIdentityFailures(
        {...identity, sourceVersion: 'garbage'},
        {commit: COMMIT, sourceVersion: 'garbage'},
      ),
    ).toContain('candidate binding source version must name an explicit package version');
  });

  it('accepts explicit prerelease and build metadata versions', () => {
    for (const version of ['0.0.0', '4.6.8-rc.1', '4.6.8-0', '4.6.8+build.01', '4.6.8-rc.1+build.2']) {
      expect(contextBriefCitationScaleCandidateBinding(COMMIT, {version}).sourceVersion).toBe(`threadnote-${version}`);
    }
  });

  it('accepts exactly the independently supplied candidate commit and package version', () => {
    fc.assert(
      fc.property(
        fc.record({major: fc.integer({min: 1, max: 20}), minor: fc.nat(30), patch: fc.nat(100)}),
        fc.boolean(),
        fc.boolean(),
        ({major, minor, patch}, commitMatches, versionMatches) => {
          const version = `${major}.${minor}.${patch}`;
          const candidate = contextBriefCitationScaleCandidateBinding(COMMIT, {version});
          const observed = {
            ...identity,
            candidateCommit: commitMatches ? COMMIT : 'b'.repeat(40),
            commit: commitMatches ? COMMIT : 'b'.repeat(40),
            sourceVersion: `threadnote-${major}.${minor}.${versionMatches ? patch : patch + 1}`,
          };
          expect(contextBriefCitationScaleReleaseIdentityFailures(observed, candidate).length === 0).toBe(
            commitMatches && versionMatches,
          );
        },
      ),
      {numRuns: 50},
    );
  });

  // provideTestLayer owns the Effect scope, including the temporary Git checkout.
  effectIt.effect('reads committed package bytes and rejects dirty, wrong-commit, and wrong-build observations', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-candidate-'});
      const manifestPath = path.join(root, 'package.json');
      yield* fs.writeFileString(manifestPath, '{"version":"4.6.8"}\n');
      yield* runCommandEffect('git', ['init', '--quiet'], {cwd: root});
      yield* runCommandEffect('git', ['add', 'package.json'], {cwd: root});
      yield* runCommandEffect(
        'git',
        [
          '-c',
          'commit.gpgSign=false',
          '-c',
          'user.name=Threadnote Test',
          '-c',
          'user.email=test@threadnote.local',
          'commit',
          '--quiet',
          '-m',
          'candidate',
        ],
        {cwd: root},
      );
      const commit = (yield* runCommandEffect('git', ['rev-parse', 'HEAD'], {cwd: root})).stdout.trim();
      expect(yield* readContextBriefCitationScaleCandidate(commit, 'threadnote-4.6.8', root)).toEqual({
        commit,
        sourceVersion: 'threadnote-4.6.8',
      });
      const wrongBuild = yield* readContextBriefCitationScaleCandidate(commit, 'threadnote-4.6.0', root).pipe(
        Effect.result,
      );
      expect(Result.isFailure(wrongBuild)).toBe(true);
      if (Result.isFailure(wrongBuild))
        expect(wrongBuild.failure.message).toContain('required candidate package version threadnote-4.6.8');
      const wrongCommit = yield* readContextBriefCitationScaleCandidate(COMMIT, 'threadnote-4.6.8', root).pipe(
        Effect.result,
      );
      expect(Result.isFailure(wrongCommit)).toBe(true);
      yield* fs.writeFileString(manifestPath, '{"version":"4.6.9"}\n');
      const dirty = yield* readContextBriefCitationScaleCandidate(commit, 'threadnote-4.6.9', root).pipe(Effect.result);
      expect(Result.isFailure(dirty)).toBe(true);
      if (Result.isFailure(dirty)) expect(dirty.failure.message).toContain('clean candidate checkout');
    }).pipe(provideTestLayer(candidateLayer), TestClock.withLive),
  );
});
