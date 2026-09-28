import {Layer} from 'effect';
import {CodeGraphObservability, CodeGraphProcessActivity} from '@threadnote/graph/runtime_ports';
import {makeCodeGraphBuildAnonymousTelemetryReporter, emitCodeGraphBackgroundFailure} from './anonymous_telemetry.js';
import {makeCodeGraphWorksetTelemetryReporter} from './workset/telemetry.js';
import {
  anonymousTelemetryDiagnosticFromError,
  anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure,
} from '../telemetry/diagnostic.js';
import {withThreadnoteProcessActivity} from '../process/diagnostics.js';

export const codeGraphRuntimeAdapters = Layer.mergeAll(
  Layer.succeed(CodeGraphObservability, {
    makeBuildReporter: makeCodeGraphBuildAnonymousTelemetryReporter,
    makeWorksetReporter: makeCodeGraphWorksetTelemetryReporter(),
    backgroundFailure: (component, event) =>
      emitCodeGraphBackgroundFailure(
        component,
        event.operation,
        event.operation === 'graph-refresh'
          ? anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure(event.failure)
          : anonymousTelemetryDiagnosticFromError(event.error),
      ),
  }),
  Layer.succeed(CodeGraphProcessActivity, {withActivity: withThreadnoteProcessActivity}),
);
