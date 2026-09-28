import {Layer} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {testRuntimePolicyLayer} from './runtime-policy.js';

export const TestSystemInfoLayer = SystemInfo.layer.pipe(Layer.provide(testRuntimePolicyLayer));
export const TestCommandExecutorLayer = CommandExecutor.layer.pipe(Layer.provide(testRuntimePolicyLayer));
