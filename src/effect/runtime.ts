import {NodeFileSystem} from '@effect/platform-node';
import {Layer} from 'effect';
import {CommandExecutor} from './command.js';
import {HttpService} from './http.js';

export const ApplicationLayer = Layer.mergeAll(CommandExecutor.layer, HttpService.layer, NodeFileSystem.layer);

export type ApplicationServices = Layer.Success<typeof ApplicationLayer>;
