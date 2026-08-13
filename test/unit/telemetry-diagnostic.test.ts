import {describe, expect, it} from 'vitest';
import {ApplicationError} from '../../src/effect/errors.js';
import {CodeGraphStoreError} from '../../src/code_graph/types.js';
import {InsufficientMemory} from '../../src/effect/ai/errors.js';
import {HomeMigrationInsufficientSpace} from '../../src/migration/home.js';
import {StorageLayoutMigrationConflict} from '../../src/migration/layout.js';
import {ReportIssueCreateFailed} from '../../src/report_issue.js';
import {CursorAttestationError} from '../../src/cursor_cloud_attestation.js';
import {
  anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure,
  anonymousTelemetryDiagnosticFromError,
  attachAnonymousTelemetryError,
  attachAnonymousTelemetryReportedOutcome,
  copyAnonymousTelemetryMetadata,
  readAnonymousTelemetryDiagnostic,
  readAnonymousTelemetryReportedOutcome,
} from '../../src/telemetry/diagnostic.js';

describe('anonymous telemetry diagnostics', () => {
  it('keeps a stable tagged failure instead of traversing into a private generic cause', () => {
    const diagnostic = anonymousTelemetryDiagnosticFromError(
      new InsufficientMemory({
        cause: new Error('allocation failed at /Users/private/model.gguf'),
        message: 'Private model failure',
        modelId: 'private-model-id',
      }),
    );

    expect(diagnostic).toEqual({errorType: 'InsufficientMemory'});
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });

  it.each([
    {
      error: new HomeMigrationInsufficientSpace({
        availableBytes: 1,
        message: 'private home migration path',
        requiredBytes: 2,
      }),
      errorType: 'HomeMigrationInsufficientSpace',
    },
    {
      error: new StorageLayoutMigrationConflict({
        message: 'private storage layout conflict',
        path: '/Users/private/threadnote',
      }),
      errorType: 'StorageLayoutMigrationConflict',
    },
    {
      error: new ReportIssueCreateFailed({message: 'private report issue body'}),
      errorType: 'ReportIssueCreateFailed',
    },
    {
      error: new CursorAttestationError('private cursor attestation response'),
      errorType: 'CursorAttestationError',
    },
  ])('projects $errorType through the closed error-type registry', ({error, errorType}) => {
    const diagnostic = anonymousTelemetryDiagnosticFromError(error);

    expect(diagnostic).toEqual({errorType});
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });

  it('projects a structured storage failure through an ApplicationError wrapper', () => {
    const storageError = new CodeGraphStoreError(
      'load code graph adjacency failed at /private/repository/store.sqlite for secret query',
      {code: 'unknown', operation: 'load code graph adjacency', recovery: 'diagnose', retryable: false},
    );
    const error = new ApplicationError({
      cause: storageError,
      message: storageError.message,
      operation: 'inspect graph',
    });

    expect(anonymousTelemetryDiagnosticFromError(error)).toEqual({
      code: 'unknown',
      domain: 'code-graph-storage',
      errorType: 'CodeGraphStoreError',
      operation: 'load code graph adjacency',
      recovery: 'diagnose',
      retryable: false,
    });
    expect(JSON.stringify(anonymousTelemetryDiagnosticFromError(error))).not.toContain('/private/repository');
    expect(JSON.stringify(anonymousTelemetryDiagnosticFromError(error))).not.toContain('secret query');
  });

  it('attaches the diagnostic without changing the MCP wire result', () => {
    const result = attachAnonymousTelemetryError(
      {content: [{type: 'text', text: 'safe user-facing error'}], isError: true},
      new CodeGraphStoreError('private native message', {
        code: 'transient-io',
        operation: 'load code graph adjacency',
        recovery: 'retry-read-only',
        retryable: true,
      }),
    );

    expect(Object.keys(result)).toEqual(['content', 'isError']);
    expect(JSON.stringify(result)).toBe('{"content":[{"type":"text","text":"safe user-facing error"}],"isError":true}');
    expect(readAnonymousTelemetryDiagnostic(result)).toMatchObject({
      code: 'transient-io',
      domain: 'code-graph-storage',
      retryable: true,
    });
  });

  it('keeps only a bounded type for arbitrary errors and rejects unsafe operation labels', () => {
    const privateError = new Error('secret at /Users/private/repository');
    expect(anonymousTelemetryDiagnosticFromError(privateError)).toEqual({errorType: 'Error'});
    expect(JSON.stringify(anonymousTelemetryDiagnosticFromError(privateError))).not.toContain('/Users/private');

    const storageError = new CodeGraphStoreError('private', {operation: '/Users/private/repository'});
    expect(anonymousTelemetryDiagnosticFromError(storageError)?.operation).toBeUndefined();
  });

  it('copies closed outcome metadata without changing either MCP wire result', () => {
    const source = attachAnonymousTelemetryReportedOutcome(
      attachAnonymousTelemetryError(
        {content: [{type: 'text', text: 'safe retry response'}]},
        new CodeGraphStoreError('private native message'),
      ),
      'timed-out',
    );
    const target = copyAnonymousTelemetryMetadata({content: [{type: 'text', text: 'safe retry response'}]}, source);

    expect(JSON.stringify(source)).toBe('{"content":[{"type":"text","text":"safe retry response"}]}');
    expect(JSON.stringify(target)).toBe(JSON.stringify(source));
    expect(readAnonymousTelemetryReportedOutcome(target)).toBe('timed-out');
    expect(readAnonymousTelemetryDiagnostic(target)).toEqual(readAnonymousTelemetryDiagnostic(source));
  });

  it('fails closed for invalid outcome and refresh diagnostic fields', () => {
    const result = attachAnonymousTelemetryReportedOutcome({content: []}, 'private-customer-outcome' as 'failure');
    const diagnostic = anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure({
      code: 'private-code' as 'unknown',
      operation: 'refresh code graph',
      recovery: 'private-recovery' as 'diagnose',
      retryable: true,
    });

    expect(readAnonymousTelemetryReportedOutcome(result)).toBeUndefined();
    expect(diagnostic).toEqual({errorType: 'CodeGraphStoreError'});
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });
});
