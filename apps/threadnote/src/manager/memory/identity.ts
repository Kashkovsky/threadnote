import {Effect} from 'effect';
import {resolveMemoryIdentityAliases} from '@threadnote/recall/memory/identity';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';

export const resolveManagerMemoryIdentity = Effect.fn('manager.resolveMemoryIdentity')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const [resolved] = yield* resolveMemoryIdentityAliases(
    config,
    [uri],
    [`threadnote://user/${uriSegment(config.user)}/memories`],
    {validateNow: true},
  );
  return resolved;
});
