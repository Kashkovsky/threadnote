import {it as effectIt} from '@effect/vitest';
import {Effect, Stdio, Stream} from 'effect';
import {expect} from 'vitest';
import {readHookPayload} from '../../src/hooks.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const read = (raw: string) =>
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    return yield* readHookPayload().pipe(
      Effect.provideService(SystemInfo, {...system, stdinIsTTY: false}),
      provideTestLayer(Stdio.layerTest({stdin: Stream.make(new TextEncoder().encode(raw))})),
    );
  }).pipe(provideTestLayer(SystemInfo.layer));

effectIt.effect('reads Cursor conversation identity and workspace roots from real stdin JSON', () =>
  Effect.gen(function* () {
    const payload = yield* read(
      JSON.stringify({
        conversation_id: 'cursor-id',
        workspace_roots: ['/repo/one', '/repo/two'],
        transcript_path: '/repo/session.txt',
      }),
    );
    expect(payload).toEqual({
      sessionId: 'cursor-id',
      workspaceRoots: ['/repo/one', '/repo/two'],
      transcriptPath: '/repo/session.txt',
    });
    expect(yield* read(JSON.stringify({session_id: 'claude-id', transcript_path: '/claude/transcript.jsonl'}))).toEqual(
      {sessionId: 'claude-id', transcriptPath: '/claude/transcript.jsonl', workspaceRoots: undefined},
    );
  }),
);

effectIt.effect.each(['{broken', '[]', '', 'null'])('ignores malformed hook input %s', raw =>
  Effect.gen(function* () {
    expect(yield* read(raw)).toBeUndefined();
  }),
);

effectIt.effect('ignores invalid root arrays without leaking unrelated payload fields', () =>
  Effect.gen(function* () {
    expect(
      yield* read(
        JSON.stringify({workspace_roots: ['/repo', 3], conversation_id: 5, user_email: 'ignored@example.com'}),
      ),
    ).toEqual({workspaceRoots: undefined, sessionId: undefined, transcriptPath: undefined});
  }),
);
