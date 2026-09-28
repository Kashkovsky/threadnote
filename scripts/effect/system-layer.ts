import {Layer} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {telemetryChildEnvironmentPolicyLayer} from '@threadnote/threadnote/telemetry/session';

export const ScriptSystemInfoLayer = SystemInfo.layer.pipe(Layer.provide(telemetryChildEnvironmentPolicyLayer));
export const ScriptCommandExecutorLayer = CommandExecutor.layer.pipe(
  Layer.provide(telemetryChildEnvironmentPolicyLayer),
);
