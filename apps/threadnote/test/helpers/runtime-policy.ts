import {Layer} from 'effect';
import {telemetryChildEnvironmentPolicyLayer} from '@threadnote/threadnote/telemetry/session';
import {runtimeEntrypointLayer} from '@threadnote/threadnote/effect/runtime-entrypoint';

export const testRuntimePolicyLayer = Layer.merge(telemetryChildEnvironmentPolicyLayer, runtimeEntrypointLayer);
