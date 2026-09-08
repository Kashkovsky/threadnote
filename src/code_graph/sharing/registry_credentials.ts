import {Effect, FileSystem, Path, Redacted, Schema} from 'effect';
import {CommandExecutor} from '../../effect/command.js';
import {SystemInfo} from '../../effect/system.js';
import {readBoundedPrivateBytes} from './atomic.js';
import {graphSharingFailure} from './errors.js';
import type {GraphShareRegistryTarget} from './registry_reference.js';

const HelperName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u));
const DockerConfig = Schema.Struct({
  credHelpers: Schema.optionalKey(Schema.Record(Schema.String, HelperName)),
  credsStore: Schema.optionalKey(HelperName),
});
const HelperResponse = Schema.Struct({
  Secret: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  ServerURL: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  Username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export interface GraphShareRegistryCredential {
  readonly username: Redacted.Redacted<string>;
  readonly authorization: Redacted.Redacted<string>;
}

/** Called only after the registry target is covered by the caller's profile trust. */
export const makeGraphShareRegistryCredentialLoader = Effect.fn('codeGraph.sharing.registryCredentialLoader')(
  function* (target: GraphShareRegistryTarget) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const command = yield* CommandExecutor;
    const directory = system.environment().DOCKER_CONFIG ?? path.join(system.homeDirectory, '.docker');
    if (!path.isAbsolute(directory)) return yield* graphSharingFailure('Docker credential config must be absolute.');
    const configPath = path.join(directory, 'config.json');
    let helper: string | undefined;
    if (yield* fs.exists(configPath)) {
      const bytes = yield* readBoundedPrivateBytes(configPath, 65_536).pipe(
        Effect.mapError(() => graphSharingFailure('Docker credential config is unavailable.')),
      );
      const config = yield* Schema.decodeEffect(Schema.fromJsonString(DockerConfig))(
        new TextDecoder().decode(bytes),
      ).pipe(Effect.mapError(() => graphSharingFailure('Docker credential config is invalid.')));
      helper = config.credHelpers?.[target.registry] ?? config.credsStore;
    }
    const selected = helper;
    let username: Redacted.Redacted<string> | undefined;
    return () =>
      Effect.gen(function* () {
        if (selected === undefined) return undefined;
        const result = yield* command
          .execute(`docker-credential-${selected}`, ['get'], {
            allowFailure: true,
            input: new TextEncoder().encode(`${target.registry}\n`),
            maxOutputBytes: 16_384,
            timeoutMs: 5_000,
          })
          .pipe(Effect.mapError(() => graphSharingFailure('Registry credential helper is unavailable.')));
        if (result.exitCode !== 0) return yield* graphSharingFailure('Registry credential helper denied access.');
        const credential = yield* Schema.decodeEffect(Schema.fromJsonString(HelperResponse))(result.stdout).pipe(
          Effect.mapError(() => graphSharingFailure('Registry credential helper response is invalid.')),
        );
        if (
          credential.Username === '<token>' ||
          [...credential.Username].some(
            character => character === ':' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          (credential.ServerURL !== undefined &&
            credential.ServerURL !== target.registry &&
            credential.ServerURL !== target.origin)
        )
          return yield* graphSharingFailure('Registry credential helper identity is unsupported.');
        if (username !== undefined && Redacted.value(username) !== credential.Username) {
          return yield* graphSharingFailure('Registry credential helper changed the selected identity.');
        }
        username = Redacted.make(credential.Username);
        return {
          username,
          authorization: Redacted.make(
            `Basic ${Buffer.from(`${credential.Username}:${credential.Secret}`).toString('base64')}`,
          ),
        } satisfies GraphShareRegistryCredential;
      });
  },
);
