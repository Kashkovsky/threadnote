import {NodeCrypto, NodeFileSystem, NodePath} from '@effect/platform-node';
import {Layer} from 'effect';
import {CommandExecutor} from './command.js';
import {HttpService} from './http.js';
import {SystemInfo} from './system.js';

export const ApplicationLayer = Layer.mergeAll(
  CommandExecutor.layer,
  HttpService.layer,
  NodeCrypto.layer,
  NodeFileSystem.layer,
  NodePath.layer,
  SystemInfo.layer,
);

export type ApplicationServices = Layer.Success<typeof ApplicationLayer>;
