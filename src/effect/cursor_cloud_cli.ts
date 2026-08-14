import type {Effect} from 'effect';
import {Command, Flag} from 'effect/unstable/cli';

export interface CursorCloudAttestCliOptions {
  readonly audience: string;
  readonly challenge: string;
  readonly completionUrl: string;
  readonly endpoint: string;
  readonly expiresAt: string;
  readonly json: boolean;
  readonly nonce: string;
}

interface CursorCloudAttestFlagBuilders {
  readonly boolean: (name: string, description: string) => Flag.Flag<boolean>;
  readonly requiredString: (name: string, description: string) => Flag.Flag<string>;
}

type CursorCloudMode = 'git-beta' | 'remote-hybrid';

export function makeCursorCloudIdentityFlags(
  defaultString: (name: string, description: string, value: string) => Flag.Flag<string>,
) {
  return {
    agentId: defaultString('agent-id', 'Stable agent identity used by Cursor Cloud', 'cursor-cloud'),
    team: defaultString('team', 'Shared-memory team reserved for Cursor Cloud', 'cursor-cloud'),
    user: defaultString('user', 'Stable Threadnote user identity used by Cursor Cloud', 'cursor-cloud'),
  } as const;
}

export function makeCursorCloudModeFlag(
  defaultChoice: (
    name: string,
    choices: readonly ['git-beta', 'remote-hybrid'],
    description: string,
    value: 'git-beta',
  ) => Flag.Flag<CursorCloudMode>,
) {
  return defaultChoice('mode', ['git-beta', 'remote-hybrid'], 'Cursor Cloud memory transport mode', 'git-beta');
}

export function makeCursorCloudAttestCommand<E, R>(
  flags: CursorCloudAttestFlagBuilders,
  handler: (options: CursorCloudAttestCliOptions) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'attest',
    {
      audience: flags.requiredString('audience', 'HTTPS audience returned by begin_cursor_attestation'),
      challenge: flags.requiredString('challenge', 'Opaque challenge ID returned by begin_cursor_attestation'),
      completionUrl: flags.requiredString(
        'completion-url',
        'HTTPS completion URL returned by begin_cursor_attestation',
      ),
      endpoint: flags.requiredString('endpoint', 'Configured managed remote memory MCP endpoint'),
      expiresAt: flags.requiredString('expires-at', 'Challenge expiry returned by begin_cursor_attestation'),
      json: flags.boolean('json', 'Print a machine-readable attestation receipt'),
      nonce: flags.requiredString('nonce', 'Nonce returned by begin_cursor_attestation'),
    },
    handler,
  ).pipe(Command.withDescription('Complete a managed Threadnote challenge with Cursor workload identity'));
}
