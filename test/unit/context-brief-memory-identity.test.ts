import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {retrieveContextBriefMemoryEvidence} from '../../src/context_brief/memory_evidence.js';
import {planContextBrief} from '../../src/context_brief/planner.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('Context Brief stable memory identity eligibility', () => {
  effectIt.effect('never emits an alias identity that is divergent in the authorized corpus', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-identity-'});
      const manifestPath = path.join(home, 'seed-manifest.yaml');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'me',
      };
      yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
      const root = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'threadnote');
      yield* fs.makeDirectory(root, {recursive: true});
      yield* fs.writeFileString(path.join(root, 'first.md'), memory('First conflicting identity evidence.'));
      yield* fs.writeFileString(path.join(root, 'second.md'), memory('Second divergent identity evidence.'));
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: ['src/context_brief/memory_evidence.ts'],
        mode: 'locate',
        scope: {callerCwd: '/workspace/threadnote', kind: 'repository', project: 'threadnote'},
        task: 'conflicting identity evidence',
      });

      const retrieval = yield* retrieveContextBriefMemoryEvidence(config, plan.memory);

      expect(retrieval.candidates.length).toBeGreaterThan(0);
      expect(retrieval.candidates.every(candidate => candidate.memoryId === undefined)).toBe(true);
      expect(retrieval.gaps).toContain('stable-memory-identity-unavailable');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function memory(body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: threadnote',
    'topic: conflicting-identity',
    'memory_id: tn_context_brief_conflict',
    'source_agent_client: test',
    'timestamp: 2026-08-31T00:00:00.000Z',
    '',
    body,
  ].join('\n');
}
