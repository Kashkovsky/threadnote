import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertCodeMemoryLinkReleaseDefermentGovernance,
  CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE,
  codeMemoryLinkReleaseDefermentPath,
  parseCodeMemoryLinkReleaseDefermentV1,
  type CodeMemoryLinkReleaseDefermentGovernanceChange,
  type CodeMemoryLinkReleaseDefermentV1,
} from '../../scripts/verify-code-memory-link-release-deferment.js';

const GOVERNANCE = '4'.repeat(40);
const WAIVER_PATH = codeMemoryLinkReleaseDefermentPath('v4.6.0');

describe('Code Memory Link 4.6 release deferment', () => {
  it('parses only the exact canonical, version-bound deferment and fixed candidate receipt', () => {
    const source = `${JSON.stringify(waiver(), undefined, 2)}\n`;
    expect(
      parseCodeMemoryLinkReleaseDefermentV1({
        expectedReleaseTag: 'v4.6.0',
        repositoryPath: WAIVER_PATH,
        source,
      }),
    ).toEqual(waiver());
    expect(() =>
      parseCodeMemoryLinkReleaseDefermentV1({
        expectedReleaseTag: 'v4.6.0',
        repositoryPath: WAIVER_PATH,
        source: JSON.stringify(waiver()),
      }),
    ).toThrow(/canonical JSON/u);
    expect(() =>
      parseCodeMemoryLinkReleaseDefermentV1({
        expectedReleaseTag: 'v4.6.0',
        repositoryPath: WAIVER_PATH,
        source: `${JSON.stringify(
          {...waiver(), candidate: {...waiver().candidate, commit: 'a'.repeat(40)}},
          undefined,
          2,
        )}\n`,
      }),
    ).toThrow(/exact qualified 4\.6\.0 receipt/u);
    expect(() => codeMemoryLinkReleaseDefermentPath('v4.6.1')).toThrow(/only for v4\.6\.0/u);
  });

  it('binds one governance commit to the qualified candidate and four exact 100644 non-runtime paths', () => {
    expect(
      assertCodeMemoryLinkReleaseDefermentGovernance({
        changes: changes(),
        governanceCommit: GOVERNANCE,
        packageVersion: '4.6.0',
        parentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE.commit,
        waiver: waiver(),
        waiverPath: WAIVER_PATH,
      }),
    ).toEqual({
      candidate: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE,
      governanceCommit: GOVERNANCE,
      waiverPath: WAIVER_PATH,
    });
    expect(() =>
      assertCodeMemoryLinkReleaseDefermentGovernance({
        changes: changes().map(change =>
          change.path === '.github/workflows/publish.yml' ? {...change, mode: '100755'} : change,
        ),
        governanceCommit: GOVERNANCE,
        packageVersion: '4.6.0',
        parentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE.commit,
        waiver: waiver(),
        waiverPath: WAIVER_PATH,
      }),
    ).toThrow(/executable path/u);
  });

  it('rejects every generated extra governance path', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_.'), {minLength: 1, maxLength: 48})
          .map(parts => `unexpected/${parts.join('')}`)
          .filter(path => !changes().some(change => change.path === path)),
        repositoryPath => {
          expect(() =>
            assertCodeMemoryLinkReleaseDefermentGovernance({
              changes: [...changes(), {mode: '100644', path: repositoryPath, status: 'A'}],
              governanceCommit: GOVERNANCE,
              packageVersion: '4.6.0',
              parentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE.commit,
              waiver: waiver(),
              waiverPath: WAIVER_PATH,
            }),
          ).toThrow(/unsupported, missing, or executable path/u);
        },
      ),
      {numRuns: 50},
    );
  });

  it('pins every shipping platform build to the verifier-selected candidate while preserving normal C-A-G', async () => {
    const workflow = await Bun.file(`${process.cwd()}/.github/workflows/publish.yml`).text();
    const shippingJobs = workflow.slice(workflow.indexOf('\n  linux:'), workflow.indexOf('\n  windows-sign:'));

    expect(workflow).toContain('if [[ "$release_tag" == \'v4.6.0\' ]]');
    expect(workflow).toContain('bun scripts/verify-code-memory-link-release-deferment.ts');
    expect(workflow).toContain('bun scripts/verify-code-memory-link-release.ts');
    expect(workflow).toContain('bun run eval:code-memory-link-release --');
    expect(workflow).toContain('test/unit/code-memory-link-release-deferment.test.ts');
    expect(workflow).toContain('candidate_commit: ${{ steps.code_memory_link_release.outputs.candidate_commit }}');
    expect(shippingJobs.match(/name: Select exact verified candidate source/g)).toHaveLength(3);
    expect(shippingJobs.match(/fetch-depth: 3/g)).toHaveLength(3);
    expect(shippingJobs.match(/git checkout --detach "\$selected_commit"/g)).toHaveLength(3);
    expect(shippingJobs.match(/needs\.verify\.outputs\.candidate_commit/g)).toHaveLength(3);
    expect(shippingJobs.match(/GITHUB_EVENT_NAME" == 'workflow_dispatch'/g)).toHaveLength(3);
    expect(shippingJobs.match(/GITHUB_EVENT_NAME" == 'push'/g)).toHaveLength(3);
    expect(shippingJobs.match(/missing an exact verifier-selected candidate/g)).toHaveLength(3);
    expect(shippingJobs).not.toContain('${CANDIDATE_COMMIT:-$GITHUB_SHA}');
  });
});

function waiver(): CodeMemoryLinkReleaseDefermentV1 {
  return {
    candidate: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE,
    deferredExperiment: {
      canonicalTrialsExecuted: 0,
      followUpVersion: '4.6.1',
      minimumObservedProviderTokens: 192_000,
      scope: 'code-memory-link-c-a-g-external-agent-experiment',
    },
    reason: 'pinned-codex-0.144.5-agent-turn-exceeded-192000-tokens-without-a-file-action',
    releaseTag: 'v4.6.0',
    type: 'code-memory-link-release-experiment-deferment',
    version: 1,
  };
}

function changes(): readonly CodeMemoryLinkReleaseDefermentGovernanceChange[] {
  return [
    {mode: '100644', path: '.github/workflows/publish.yml', status: 'M'},
    {mode: '100644', path: WAIVER_PATH, status: 'A'},
    {mode: '100644', path: 'scripts/verify-code-memory-link-release-deferment.ts', status: 'A'},
    {mode: '100644', path: 'test/unit/code-memory-link-release-deferment.test.ts', status: 'A'},
  ];
}
