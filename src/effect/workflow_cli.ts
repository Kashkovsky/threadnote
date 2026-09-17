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
  requiredChoice,
  requiredString,
} from './cli_flags.js';
import type {runContextBrief} from '../context_brief/commands.js';
import type {runCompact} from '../memory/commands.js';
import type {runRecallFeedback} from '../recall/feedback_commands.js';
import type {runContextHealth} from '../memory/context_health_commands.js';
import type {
  runContextHealthRepairApply,
  runContextHealthRepairPreview,
} from '../memory/context_health_repair_commands.js';
import type {runContextCheck} from '../context_check/commands.js';
import type {
  runValueReport,
  runValueReportDelete,
  runValueReportExport,
  runValueReportRetention,
} from '../value_report/commands.js';
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

export function makeRecallFeedbackCommand<E, R>(
  handler: (options: Parameters<typeof runRecallFeedback>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'recall-feedback',
    {
      action: requiredChoice('action', ['useful', 'wrong', 'pin', 'dismiss', 'applied'], 'Feedback action'),
      project: optionalString('project', 'Project scope; required for pin because pins are never global'),
      query: requiredString('query', 'The original recall query; only its SHA-256 fingerprint is stored'),
      uri: argument('uri', 'The recalled threadnote:// result URI'),
    },
    handler,
  ).pipe(Command.withDescription('Record local feedback for one recalled result'));
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

export function makeContextHealthRepairCommand<E, R>(
  previewHandler: (options: Parameters<typeof runContextHealthRepairPreview>[1]) => Effect.Effect<void, E, R>,
  applyHandler: (options: Parameters<typeof runContextHealthRepairApply>[1]) => Effect.Effect<void, E, R>,
) {
  const preview = Command.make(
    'preview',
    {
      json: boolean('json', 'Emit the bounded ContextHealthRepairPlanV1 as JSON'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
    },
    previewHandler,
  ).pipe(Command.withDescription('Preview exact, bounded repairs without changing memory'));

  const apply = Command.make(
    'apply',
    {
      approved: boolean('approved', 'Confirm explicit approval for this exact repair proposal revision'),
      json: boolean('json', 'Emit the ContextHealthRepairApplyResultV1 as JSON'),
      project: requiredString('project', 'Project/repo namespace containing the reviewed proposal'),
      proposalId: requiredString('proposal-id', 'Exact proposal ID from context repair preview'),
      revision: requiredString('revision', 'Exact proposal revision from context repair preview'),
    },
    applyHandler,
  ).pipe(Command.withDescription('Apply one explicitly approved, revision-checked personal-memory repair'));

  return Command.make('repair').pipe(
    Command.withDescription('Preview or apply reviewable context-health repairs'),
    Command.withSubcommands([preview, apply]),
  );
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

export function makeValueCommand<E, R>(
  handler: (options: Parameters<typeof runValueReport>[1]) => Effect.Effect<void, E, R>,
  exportHandler: (options: Parameters<typeof runValueReportExport>[1]) => Effect.Effect<void, E, R>,
  retentionHandler: (options: Parameters<typeof runValueReportRetention>[1]) => Effect.Effect<void, E, R>,
  deleteHandler: (options: Parameters<typeof runValueReportDelete>[1]) => Effect.Effect<void, E, R>,
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

  const retentionCommand = Command.make(
    'retention',
    {
      apply: boolean('apply', 'Prune the selected expired local inputs after previewing the count-only receipt'),
      days: optional(
        describeFlag(
          integerFlag('days').pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
          'Keep feedback and value events from this many days (default 365)',
        ),
      ),
    },
    retentionHandler,
  ).pipe(Command.withDescription('Preview or apply one-time local feedback and value-event retention'));

  const deleteCommand = Command.make(
    'delete',
    {
      all: boolean('all', 'Select feedback, value events, and explicit export bundles'),
      apply: boolean('apply', 'Delete the selected local value data after previewing the count-only receipt'),
      events: boolean('events', 'Select local Context Brief, setup, and health value events'),
      exports: boolean('exports', 'Select explicit redacted value-report export bundles'),
      feedback: boolean('feedback', 'Select local recall feedback events'),
    },
    deleteHandler,
  ).pipe(Command.withDescription('Preview or explicitly delete selected local value data'));

  const reportCommand = Command.make(
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
    Command.withSubcommands([exportCommand, retentionCommand, deleteCommand]),
  );
  return Command.make('value').pipe(
    Command.withDescription('Inspect local, count-only value signals'),
    Command.withSubcommands([reportCommand]),
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
