import * as NodeServices from '@effect/platform-node/NodeServices';
import {Layer} from 'effect';
import {CommandExecutor} from './command.js';
import {HttpService} from './http.js';
import {SystemInfo} from './system.js';

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));

const ApplicationServicesLayer = Layer.mergeAll(commandLayer, HttpService.layer, systemLayer);

export const ApplicationLayer = ApplicationServicesLayer.pipe(Layer.provideMerge(NodeServices.layer));

export type ApplicationServices = Layer.Success<typeof ApplicationLayer>;
