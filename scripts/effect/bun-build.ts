import {Effect} from 'effect';
import {ScriptError} from './errors.js';

type BunBuild = (options: Bun.BuildConfig) => Promise<Bun.BuildOutput>;

const BUILD_FAILURE_MESSAGE = 'Bun could not build the standalone artifact.';

export function runBunBuild(options: Bun.BuildConfig, build: BunBuild = Bun.build) {
  return Effect.tryPromise({
    try: () => build(options),
    catch: cause => bunBuildScriptError(cause),
  }).pipe(
    Effect.flatMap(result =>
      result.success
        ? Effect.void
        : Effect.fail(
            ScriptError.make({
              message: result.logs
                .map(log => log.message)
                .filter(Boolean)
                .join('\n'),
            }),
          ),
    ),
  );
}

function bunBuildScriptError(cause: unknown): ScriptError {
  const diagnostics = cause instanceof AggregateError ? cause.errors.map(renderBuildDiagnostic).filter(Boolean) : [];
  return ScriptError.make({message: renderBuildFailure(diagnostics), cause});
}

function renderBuildFailure(diagnostics: ReadonlyArray<string>): string {
  return diagnostics.length === 0
    ? BUILD_FAILURE_MESSAGE
    : `${BUILD_FAILURE_MESSAGE}\nBuild diagnostics:\n${diagnostics.join('\n')}`;
}

function renderBuildDiagnostic(value: unknown): string {
  const message = diagnosticMessage(value);
  if (!message) return '';

  const position = isRecord(value) && isRecord(value.position) ? value.position : undefined;
  const file = position && typeof position.file === 'string' ? position.file : undefined;
  const line = position && typeof position.line === 'number' ? position.line : undefined;
  const column = position && typeof position.column === 'number' ? position.column : undefined;
  const location = file
    ? [file, line, column].filter((part): part is string | number => part !== undefined).join(':')
    : undefined;
  const lineText = position && typeof position.lineText === 'string' ? position.lineText.trimEnd() : undefined;

  return [`${location ? `${location}: ` : ''}${message}`, lineText ? `  ${lineText}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join('\n');
}

function diagnosticMessage(value: unknown): string {
  if (value instanceof Error) return value.message.trim();
  if (isRecord(value) && typeof value.message === 'string') return value.message.trim();
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
