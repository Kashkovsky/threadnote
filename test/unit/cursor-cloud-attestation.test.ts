import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  completeCursorAttestationChallenge,
  CursorAttestationError,
  runCursorAttestationChallenge,
  validateCursorAttestationChallenge,
  type CursorAttestationExchangeClient,
} from '../../src/cursor_cloud_attestation.js';
import {CommandExecutor, type CommandOptions} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const now = Date.parse('2026-08-13T08:00:00.000Z');
const endpoint = 'https://memory.threadnote.io/mcp';
const challenge = {
  audience: 'https://memory.threadnote.io/attest/cursor',
  challengeId: 'challenge_123',
  completionUrl: 'https://memory.threadnote.io/attest/cursor/complete',
  expiresAt: '2026-08-13T08:05:00.000Z',
  nonce: 'nonce_1234567890',
} as const;

describe('Cursor Cloud workload attestation', () => {
  it('accepts only fresh challenge metadata for the exact managed attestation service', () => {
    expect(validateCursorAttestationChallenge(challenge, endpoint, now)).toEqual({...challenge, version: 1});
    expect(() =>
      validateCursorAttestationChallenge(
        {...challenge, completionUrl: 'https://attacker.example/complete'},
        endpoint,
        now,
      ),
    ).toThrow('must match the configured remote memory service');
    expect(() =>
      validateCursorAttestationChallenge(
        {...challenge, audience: 'https://memory.threadnote.io/attest/another-service'},
        endpoint,
        now,
      ),
    ).toThrow('must match the configured remote memory service');
    expect(() =>
      validateCursorAttestationChallenge(
        {...challenge, completionUrl: 'https://memory.threadnote.io/attest/cursor/other'},
        endpoint,
        now,
      ),
    ).toThrow('must match the configured remote memory service');
    expect(() =>
      validateCursorAttestationChallenge({...challenge, expiresAt: '2026-08-13T07:59:00.000Z'}, endpoint, now),
    ).toThrow('expired or has an invalid lifetime');
    expect(() => validateCursorAttestationChallenge({...challenge, nonce: 'short'}, endpoint, now)).toThrow(
      'portable opaque identifier',
    );
  });

  effectIt.effect('returns only the opaque attestation receipt', () =>
    Effect.gen(function* () {
      let postedToken = '';
      const client: CursorAttestationExchangeClient = {
        complete: (_challenge, token) =>
          Effect.sync(() => {
            postedToken = token;
            return {attestationId: 'attestation_456', expiresAt: '2026-08-13T08:04:00.000Z'};
          }),
        mint: () => Effect.succeed({expiresAt: Math.floor((now + 300_000) / 1_000), token: 'signed.jwt.value'}),
      };

      const receipt = yield* completeCursorAttestationChallenge(challenge, endpoint, client, now);

      expect(postedToken).toBe('signed.jwt.value');
      expect(receipt).toEqual({
        attestationId: 'attestation_456',
        expiresAt: '2026-08-13T08:04:00.000Z',
      });
      expect(JSON.stringify(receipt)).not.toContain('signed.jwt.value');
    }),
  );

  effectIt.effect('posts the nonce-bound token directly without placing it in argv or the receipt', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const token = 'signed.jwt.private-value';
      const requests: {readonly args: readonly string[]; readonly body: string; readonly options: CommandOptions}[] =
        [];
      const command = CommandExecutor.of({
        execute: (_executable, args, options = {}) =>
          Effect.sync(() => {
            const body = new TextDecoder().decode(options.input);
            requests.push({args, body, options});
            return {
              exitCode: 0,
              stderr: '',
              stdout:
                requests.length === 1
                  ? `${JSON.stringify({expires_at: Math.floor((Date.now() + 300_000) / 1_000), token})}\n200`
                  : `${JSON.stringify({attestationId: 'attestation_direct', expiresAt: new Date(Date.now() + 240_000).toISOString()})}\n200`,
            };
          }),
        executeStreaming: () => Effect.die('not used'),
      });
      const testSystem = SystemInfo.of({
        ...system,
        environment: () => ({CURSOR_AGENT_SOCKET: '/run/cursor/test-api.sock'}),
      });
      const liveChallenge = {
        ...challenge,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };

      const receipt = yield* runCursorAttestationChallenge(liveChallenge, endpoint).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, testSystem),
      );

      expect(requests).toHaveLength(2);
      expect(requests[0]?.args).toContain('/run/cursor/test-api.sock');
      expect(requests[0]?.args).toContain('http://cursor-agent/v1/tokens/oidc');
      expect(requests[0]?.args).toEqual(expect.arrayContaining(['--retry', '2', '--retry-connrefused']));
      expect(JSON.parse(requests[0]?.body ?? '')).toEqual({aud: challenge.audience, nonce: challenge.nonce});
      expect(requests[1]?.args).toContain(challenge.completionUrl);
      expect(requests[1]?.args).not.toContain('--retry');
      expect(JSON.parse(requests[1]?.body ?? '')).toEqual({challengeId: challenge.challengeId, token});
      expect(requests.flatMap(request => request.args).join('\n')).not.toContain(token);
      expect(JSON.stringify(receipt)).not.toContain(token);
      expect(receipt.attestationId).toBe('attestation_direct');
    }).pipe(provideTestLayer(SystemInfo.layer)),
  );

  effectIt.effect('fails malformed curl output as a bounded expected error', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const command = CommandExecutor.of({
        execute: () => Effect.succeed({exitCode: 0, stderr: '', stdout: 'not-a-framed-response'}),
        executeStreaming: () => Effect.die('not used'),
      });
      const liveChallenge = {...challenge, expiresAt: new Date(Date.now() + 300_000).toISOString()};

      const result = yield* runCursorAttestationChallenge(liveChallenge, endpoint).pipe(
        Effect.match({
          onFailure: error => ({error}),
          onSuccess: value => ({value}),
        }),
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, system),
      );

      expect(result).toHaveProperty('error');
      if ('error' in result) {
        expect(result.error.message).toBe('Cursor workload identity token minting failed.');
        expect(result.error.message).not.toContain('not-a-framed-response');
      }
    }).pipe(provideTestLayer(SystemInfo.layer)),
  );

  effectIt.effect.prop(
    'never reflects arbitrary minted token bytes in success receipts or completion failures',
    {fails: fc.boolean(), token: fc.stringMatching(/^[A-F0-9]{32}$/)},
    ({fails, token}) => {
      const client: CursorAttestationExchangeClient = {
        complete: () =>
          fails
            ? Effect.fail(new CursorAttestationError(`remote response included ${token}`))
            : Effect.succeed({attestationId: 'attestation_property'}),
        mint: () => Effect.succeed({expiresAt: Math.floor((now + 300_000) / 1_000), token}),
      };
      return Effect.gen(function* () {
        const outcome = yield* Effect.result(completeCursorAttestationChallenge(challenge, endpoint, client, now));
        expect(JSON.stringify(outcome)).not.toContain(token);
      });
    },
  );
});
