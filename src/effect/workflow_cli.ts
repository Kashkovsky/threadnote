import {Schema, type Effect} from 'effect';
import {Command, Flag} from 'effect/unstable/cli';
import {
  argument,
  boolean,
  defaultChoice,
  describeFlag,
  integerFlag,
  optional,
  optionalChoice,
  optionalString,
  repeatedString,
  requiredString,
} from './cli_flags.js';
import type {runContextBrief} from '../context_brief/commands.js';
import type {runCompact} from '../memory/commands.js';
import type {runContextHealth} from '../memory/context_health_commands.js';
import type {runContextCheck} from '../context_check/commands.js';
import type {runValueReport, runValueReportExport} from '../value_report/commands.js';
import type {runProcedureVerify, runProcedureStatus} from '../procedure/commands.js';
import {
  CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
} from '../context_brief/types.js';

export function makeCompactCommand<E, R>(
  handler: (options: Parameters<typeof runCompact>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'compact',
    {
      apply: boolean('apply', 'Apply the compact plan; without this, prints a dry run'),
      dryRun: boolean('dry-run', 'Print the compact plan without changing anything'),
      kind: optionalChoice('kind', ['durable', 'handoff', 'incident'], 'Optional memory kind filter'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
      topic: optionalString('topic', 'Stable topic name to inspect'),
    },
    handler,
  ).pipe(Command.withDescription('Plan or apply scoped memory hygiene for active personal memories'));
}

export function makeContextBriefCommand<E, R>(
  handler: (options: Parameters<typeof runContextBrief>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'brief',
    {
      budgetTokens: optional(
        describeFlag(
          integerFlag('budget-tokens').pipe(
            Flag.withSchema(
              Schema.Int.check(
                Schema.isBetween({
                  minimum: CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
                  maximum: CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
                }),
              ),
            ),
          ),
          `Maximum estimated tokens for the combined structured and text response (${CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS}-${CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS})`,
        ),
      ),
      codeRefs: repeatedString(
        'code-ref',
        'Canonical graph-indexed repository-relative path (no ./ or ..) or exact cgs_<32 lowercase hex>; cgr_ unsupported; repeat up to eight times',
        8,
      ),
      cwd: optionalString(
        'cwd',
        'Absolute repository path, at most 4096 UTF-8 bytes; defaults to the current directory',
      ),
      json: boolean('json', 'Print the structured Context Brief projection'),
      mode: defaultChoice('mode', ['brief', 'locate', 'explain', 'trace', 'impact'], 'Evidence-planning mode', 'brief'),
      project: optionalString('project', 'Optional memory project scope, at most 256 UTF-8 bytes'),
      task: requiredString('task', 'Engineering task or question, 1-4096 UTF-8 bytes without control characters'),
      workset: optionalString('workset', 'Prepared workset scope, at most 256 UTF-8 bytes, instead of the repository'),
    },
    handler,
  ).pipe(Command.withDescription('Compile bounded graph, decision, handoff, and freshness evidence for an agent task'));
}

export function makeContextHealthCommand<E, R>(
  handler: (options: Parameters<typeof runContextHealth>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'health',
    {
      json: boolean('json', 'Emit the bounded ContextHealthReportV1 as JSON'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
    },
    handler,
  ).pipe(Command.withDescription('Inspect active project memories and report read-only hygiene findings'));
}

export function makeContextCheckCommand<E, R>(
  handler: (options: Parameters<typeof runContextCheck>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'check',
    {
      base: optionalString(
        'base',
        'Git commit/ref to compare with the working tree, including untracked files (default HEAD)',
      ),
      format: optionalChoice('format', ['text', 'json', 'sarif'], 'Output format (default text)'),
      json: boolean('json', 'Emit privacy-safe ContextCheckReportV1 JSON'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
      sarif: boolean('sarif', 'Emit SARIF 2.1.0 instead of JSON; excludes paths and memory bodies'),
    },
    handler,
  ).pipe(
    Command.withDescription('Check directly cited changed files; exit 0 clean, 1 findings, 2 unavailable evidence'),
  );
}

export function makeValueReportCommand<E, R>(
  handler: (options: Parameters<typeof runValueReport>[1]) => Effect.Effect<void, E, R>,
  exportHandler: (options: Parameters<typeof runValueReportExport>[1]) => Effect.Effect<void, E, R>,
) {
  const exportCommand = Command.make(
    'export',
    {
      apply: boolean('apply', 'Write the bounded bundle under the private Threadnote home'),
      period: optional(
        describeFlag(
          integerFlag('period').pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
          'Include local inputs from this many whole days (default 30)',
        ),
      ),
      project: optionalString(
        'project',
        'Restrict local aggregation without including the project label in the bundle',
      ),
    },
    exportHandler,
  ).pipe(Command.withDescription('Preview or explicitly write a redacted design-partner bundle'));

  return Command.make(
    'report',
    {
      json: boolean('json', 'Emit the bounded ValueReportV1 as JSON'),
      period: optional(
        describeFlag(
          integerFlag('period').pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
          'Include local inputs from this many whole days (default 30)',
        ),
      ),
      project: optionalString('project', 'Restrict local recall-feedback aggregation to one project'),
    },
    handler,
  ).pipe(
    Command.withDescription('Summarize bounded local value inputs without exporting telemetry'),
    Command.withSubcommands([exportCommand]),
  );
}

export function makeProcedureVerifyCommand<E, R>(
  handler: (options: Parameters<typeof runProcedureVerify>[0]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'verify',
    {
      apply: boolean('apply', 'Execute reviewed local verification commands with your user permissions'),
      artifact: optionalString('artifact', 'Local artifact file whose SHA-256 must match the manifest'),
      dryRun: boolean('dry-run', 'Preview only, even with --apply'),
      fixture: repeatedString(
        'fixture',
        'Local fixture mapping id=path; required for every declared fixture with --apply',
      ),
      json: boolean('json', 'Emit structured preview or verification receipt (also the default)'),
      manifest: argument('manifest', 'Explicit local procedure JSON manifest'),
      preview: boolean('preview', 'Preview only, even with --apply'),
    },
    handler,
  ).pipe(
    Command.withDescription('Preview local commands; --apply verifies content and executes in the manifest directory'),
  );
}

export function makeProcedureStatusCommand<E, R>(
  handler: (options: Parameters<typeof runProcedureStatus>[0]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'status',
    {
      artifact: requiredString('artifact', 'Local artifact file to hash without executing commands'),
      availableManifest: optionalString(
        'available-manifest',
        'Optional reviewed local manifest used only to detect a newer artifact version',
      ),
      capability: repeatedString('capability', 'Explicit host capability identifier; repeat for multiple'),
      json: boolean('json', 'Emit a structured read-only status'),
      manifest: argument('manifest', 'Explicit local procedure JSON manifest'),
      receipt: optionalString('receipt', 'Local verification receipt JSON emitted by procedure verify --apply'),
      surface: repeatedString('surface', 'Explicit host surface identifier; repeat for multiple'),
    },
    handler,
  ).pipe(
    Command.withDescription('Check a receipt, local artifact hash, and declared host compatibility without execution'),
  );
}
