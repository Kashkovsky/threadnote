import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {getAgentAdapter} from '../../src/agent_integration/adapters.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {
  GUIDANCE_BLOCK_START,
  guidanceBlock,
  guidanceImportReviewId,
  hasMalformedGuidanceBlock,
  parseGuidanceReceiptV1,
  removeGuidanceBlock,
  renderManagedGuidanceBlock,
  runGuidanceImport,
  runGuidanceProject,
  runGuidanceRemove,
  runGuidanceStatus,
  stripThreadnoteManagedGuidance,
  upsertGuidanceBlock,
} from '../../src/guidance/index.js';
import {listCandidateReviews} from '../../src/memory/candidate.js';
import {runRemember} from '../../src/memory/index.js';
import type {RuntimeConfig} from '../../src/types.js';
import {runCommand} from '../../src/utils.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const first = {contentHash: 'a'.repeat(64), text: 'Use reviewed context.', uri: 'threadnote://memory/a'};
const second = {contentHash: 'b'.repeat(64), text: 'Keep evidence current.', uri: 'threadnote://memory/b'};

describe('project guidance blocks', () => {
  it('is source-order invariant and idempotent', () => {
    const forward = renderManagedGuidanceBlock([first, second]);
    const reverse = renderManagedGuidanceBlock([second, first]);
    expect(forward).toBe(reverse);
    expect(upsertGuidanceBlock(upsertGuidanceBlock('local\n', forward), forward)).toBe(
      upsertGuidanceBlock('local\n', forward),
    );
  });

  it('preserves unmanaged content through projection and removal', () => {
    const block = renderManagedGuidanceBlock([first]);
    const projected = upsertGuidanceBlock('before\n\nafter\n', block);
    expect(guidanceBlock(projected)).toBe(block);
    expect(removeGuidanceBlock(projected)).toBe('before\n\nafter\n');
  });

  it('keeps provider-neutral managed bytes across plain and wrapped adapters', () => {
    const codex = getAgentAdapter('codex-cli')!;
    const cursor = getAgentAdapter('cursor-desktop')!;
    const block = renderManagedGuidanceBlock([first, second]);
    const codexDocument = upsertGuidanceBlock(undefined, block, codex.guidance?.projection.wrapper);
    const cursorDocument = upsertGuidanceBlock(undefined, block, cursor.guidance?.projection.wrapper);
    expect(codex.guidance?.projection.relativePath).not.toBe(cursor.guidance?.projection.relativePath);
    expect(codexDocument).not.toBe(cursorDocument);
    expect(guidanceBlock(codexDocument)).toBe(block);
    expect(guidanceBlock(cursorDocument)).toBe(block);
  });

  it('does not import its own project or bootstrap blocks', () => {
    const projected = upsertGuidanceBlock('human rules\n', renderManagedGuidanceBlock([first]));
    expect(stripThreadnoteManagedGuidance(projected)).toBe('human rules\n');
    expect(
      stripThreadnoteManagedGuidance(
        'before\n<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->\nmanaged\n<!-- END THREADNOTE USER INSTRUCTIONS -->\nafter\n',
      ),
    ).toBe('before\nafter\n');
  });

  it('refuses incomplete or duplicate managed markers', () => {
    expect(hasMalformedGuidanceBlock('before\n<!-- threadnote:project-guidance:start v1 -->')).toBe(true);
    expect(
      hasMalformedGuidanceBlock(
        '<!-- threadnote:project-guidance:start v1 --><!-- threadnote:project-guidance:end --><!-- threadnote:project-guidance:start v1 --><!-- threadnote:project-guidance:end -->',
      ),
    ).toBe(true);
    expect(() => upsertGuidanceBlock('<!-- threadnote:project-guidance:start v1 -->', 'block')).toThrow();
    expect(() => renderManagedGuidanceBlock([{...first, text: GUIDANCE_BLOCK_START}])).toThrow(/reserved/u);
    expect(() =>
      stripThreadnoteManagedGuidance(
        '<!-- END THREADNOTE USER INSTRUCTIONS --><!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
      ),
    ).toThrow(/incomplete, reversed, or duplicated/u);
  });

  it('uses a deterministic import review identity', () => {
    expect(guidanceImportReviewId('codex-cli', 'threadnote', 'rules')).toBe(
      guidanceImportReviewId('codex-cli', 'threadnote', 'rules'),
    );
    expect(guidanceImportReviewId('codex-cli', 'threadnote', 'rules')).not.toBe(
      guidanceImportReviewId('claude-code', 'threadnote', 'rules'),
    );
  });

  it('is idempotent and round-trips arbitrary unmanaged content byte-for-byte', () => {
    fc.assert(
      fc.property(
        fc.string().filter(value => !value.includes('threadnote:project-guidance:')),
        text => {
          const block = renderManagedGuidanceBlock([first]);
          const projected = upsertGuidanceBlock(text, block);
          expect(upsertGuidanceBlock(projected, block)).toBe(projected);
          expect(removeGuidanceBlock(projected)).toBe(text);
        },
      ),
      {numRuns: 50},
    );
  });

  it('strictly validates bounded receipt identity and shape', () => {
    const expected = {project: 'threadnote', repositoryId: 'repo', surface: 'codex-cli', targetPath: 'AGENTS.md'};
    const receipt = {
      expectedManagedBlockHash: 'a'.repeat(64),
      previousManagedBlockHash: null,
      project: expected.project,
      removeTargetWhenEmpty: true,
      repositoryId: expected.repositoryId,
      sources: [{contentHash: 'b'.repeat(64), uri: 'threadnote://memory/tn_guidance'}],
      state: 'current',
      surface: expected.surface,
      targetPath: expected.targetPath,
      version: 1,
      wrapperOwned: false,
    } as const;
    expect(parseGuidanceReceiptV1(receipt, expected)).toEqual(receipt);
    expect(() => parseGuidanceReceiptV1({...receipt, surface: 'other'}, expected)).toThrow();
    expect(() => parseGuidanceReceiptV1({...receipt, unexpected: true}, expected)).toThrow();
    expect(() => parseGuidanceReceiptV1({...receipt, expectedManagedBlockHash: 'short'}, expected)).toThrow();
  });

  effectIt.effect('imports exact Markdown once without mutating during preview', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture();
        const source = '# Rules\n\n- Keep lists\n\n```ts\nconst exact = true;\n```\n';
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, 'AGENTS.md'), source);
        const adapter = getAgentAdapter('codex-cli')!;
        expect(
          yield* runGuidanceImport(fixture.config, adapter, {
            apply: false,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
        expect(yield* listCandidateReviews(fixture.home)).toEqual([]);
        expect(
          yield* runGuidanceImport(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'created'});
        const reviews = yield* listCandidateReviews(fixture.home);
        expect(reviews).toHaveLength(1);
        expect(reviews[0]?.candidates[0]?.proposedText).toBe(source.trim());
        expect(
          yield* runGuidanceImport(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'reused'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves a wrapped surface preimage and force-removes only the managed block', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Keep project memory.');
        const adapter = getAgentAdapter('cursor-desktop')!;
        const target = fixture.path.join(fixture.repository, '.cursor/rules/threadnote.mdc');
        const original = '---\ndescription: Existing project rules\n---\n\nKeep local.\n';
        yield* fixture.fs.makeDirectory(fixture.path.dirname(target), {recursive: true});
        yield* fixture.fs.writeFileString(target, original);
        yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        const projected = yield* fixture.fs.readFileString(target);
        expect(projected.startsWith(`${original}${GUIDANCE_BLOCK_START}`)).toBe(true);
        expect(projected.match(/^---/g)).toHaveLength(1);
        expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
          state: 'current',
        });
        yield* fixture.fs.writeFileString(target, projected.replace('Keep project memory.', 'Locally changed.'));
        expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
          state: 'locally-modified',
        });
        const refused = yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(refused)).toContain('rerun with --force');
        yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: true,
          project: 'threadnote',
        });
        expect(yield* fixture.fs.readFileString(target)).toBe(original);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('resumes a pending receipt and removes a created target without force', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Resume exact projection.');
        const adapter = getAgentAdapter('codex-cli')!;
        const target = fixture.path.join(fixture.repository, 'AGENTS.md');
        expect(
          yield* runGuidanceProject(fixture.config, adapter, {
            apply: false,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
        expect(yield* fixture.fs.exists(target)).toBe(false);
        yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        const receiptDirectory = fixture.path.join(fixture.home, 'guidance/v1/receipts');
        const [receiptName] = yield* fixture.fs.readDirectory(receiptDirectory);
        const receiptPath = fixture.path.join(receiptDirectory, receiptName);
        const receipt = JSON.parse(yield* fixture.fs.readFileString(receiptPath)) as Record<string, unknown>;
        yield* fixture.fs.writeFileString(
          receiptPath,
          `${JSON.stringify({...receipt, state: 'pending'}, undefined, 2)}\n`,
        );
        expect(
          yield* runGuidanceProject(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'resumed'});
        yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          project: 'threadnote',
        });
        expect(yield* fixture.fs.exists(target)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes an owned wrapper after unmanaged text is prepended and appended', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Wrapped projection.');
        const adapter = getAgentAdapter('cursor-desktop')!;
        const target = fixture.path.join(fixture.repository, '.cursor/rules/threadnote.mdc');
        yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        const projected = yield* fixture.fs.readFileString(target);
        yield* fixture.fs.writeFileString(target, `before\n${projected}after\n`);
        expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
          state: 'locally-modified',
        });
        yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: true,
          project: 'threadnote',
        });
        expect(yield* fixture.fs.readFileString(target)).toBe('before\nafter\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('resumes an interrupted update before and after its target write', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Original projection.');
        const adapter = getAgentAdapter('codex-cli')!;
        const options = {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        } as const;
        yield* runGuidanceProject(fixture.config, adapter, options);
        const receiptDirectory = fixture.path.join(fixture.home, 'guidance/v1/receipts');
        const [receiptName] = yield* fixture.fs.readDirectory(receiptDirectory);
        const receiptPath = fixture.path.join(receiptDirectory, receiptName);
        const oldReceipt = JSON.parse(yield* fixture.fs.readFileString(receiptPath)) as {
          readonly expectedManagedBlockHash: string;
        };
        const system = yield* SystemInfo;
        yield* runRemember(fixture.config, {
          kind: 'durable',
          project: 'threadnote',
          replace: fixture.memoryUri,
          sourceAgentClient: 'test',
          text: 'Updated projection.',
          topic: 'guidance',
        }).pipe(
          Effect.provideService(SystemInfo, SystemInfo.of({...system, currentDirectory: () => fixture.repository})),
        );
        const preview = yield* runGuidanceProject(fixture.config, adapter, {...options, apply: false});
        const pendingReceipt = {
          ...preview.receipt,
          previousManagedBlockHash: oldReceipt.expectedManagedBlockHash,
          state: 'pending',
        };
        yield* fixture.fs.writeFileString(receiptPath, `${JSON.stringify(pendingReceipt, undefined, 2)}\n`);
        expect(yield* runGuidanceProject(fixture.config, adapter, options)).toMatchObject({mode: 'applied'});
        expect(yield* fixture.fs.readFileString(fixture.path.join(fixture.repository, 'AGENTS.md'))).toContain(
          'Updated projection.',
        );
        yield* fixture.fs.writeFileString(receiptPath, `${JSON.stringify(pendingReceipt, undefined, 2)}\n`);
        expect(yield* runGuidanceProject(fixture.config, adapter, options)).toMatchObject({mode: 'resumed'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses to read a symlinked project target during preview', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Do not follow links.');
        const outside = fixture.path.join(fixture.root, 'outside.md');
        yield* fixture.fs.writeFileString(outside, 'outside\n');
        yield* fixture.fs.symlink(outside, fixture.path.join(fixture.repository, 'AGENTS.md'));
        const failure = yield* runGuidanceProject(fixture.config, getAgentAdapter('codex-cli')!, {
          apply: false,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('symbolic link');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const makeGuidanceFixture = Effect.fn('test.guidanceFixture')(function* (memoryText?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-guidance-'});
  const repository = path.join(root, 'repository');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(repository, {recursive: true});
  yield* runCommand('git', ['init'], {cwd: repository});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'seed-manifest.yaml'),
    user: 'tester',
  };
  const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/guidance.md';
  if (memoryText !== undefined) {
    const repositorySystem = SystemInfo.of({...system, currentDirectory: () => repository});
    yield* runRemember(config, {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      text: memoryText,
      topic: 'guidance',
    }).pipe(Effect.provideService(SystemInfo, repositorySystem));
  }
  return {config, fs, home, memoryUri, path, repository, root};
});
