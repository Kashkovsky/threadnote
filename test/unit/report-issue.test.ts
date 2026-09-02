import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {CommandExecutor, CommandSpawnFailed} from '../../src/effect/command.js';
import {withProductionLogging} from '../../src/effect/production_log.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {ReportIssueCreateFailed, ReportIssueInvalid, runReportIssue} from '../../src/report_issue.js';
import type {RuntimeConfig} from '../../src/types.js';
import {SystemInfo} from '../../src/effect/system.js';

describe('report issue', () => {
  effectIt.effect('previews an allowlisted log excerpt without invoking GitHub', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config, fs, path} = yield* reportIssueTestHome('preview');
        yield* withProductionLogging(config.agentContextHome, {component: 'cli', operation: 'doctor'}, Effect.void);
        const logPath = path.join(config.agentContextHome, 'logs', 'threadnote.log');
        const validEntry = JSON.parse((yield* fs.readFileString(logPath)).trim().split('\n')[0]) as Record<
          string,
          unknown
        >;
        yield* fs.writeFileString(
          logPath,
          [
            JSON.stringify({...validEntry, memoryBody: 'private-memory-content'}),
            JSON.stringify({...validEntry, operation: 'sk-1234567890abcdefghijkl'}),
            'not-json',
            '',
          ].join('\n'),
          {flag: 'a'},
        );
        let commandInvoked = false;
        const command = CommandExecutor.of({
          execute: () =>
            Effect.sync(() => {
              commandInvoked = true;
              return {exitCode: 0, stderr: '', stdout: 'https://github.com/Kashkovsky/threadnote/issues/1\n'};
            }),
          executeStreaming: () => Effect.succeed({exitCode: 0, stderr: '', stdout: ''}),
        });

        const report = yield* captureConsole(
          runReportIssue(config, {
            apply: false,
            body: 'Threadnote failed under /Users/example/private-project.',
            includeLogs: true,
            title: 'Doctor command failed',
          }),
        ).pipe(Effect.provideService(CommandExecutor, command));

        expect(commandInvoked).toBe(false);
        expect(report.output).toContain('GitHub issue preview: Kashkovsky/threadnote');
        expect(report.output).toMatch(/Approval digest: sha256:[a-f0-9]{64}/);
        expect(report.output).toContain('Production logs included: yes');
        expect(report.output).toContain('3 included, 0 older omitted, 2 invalid discarded');
        expect(report.output).toContain('"operation":"doctor"');
        expect(report.output).toContain('https://cli.github.com/');
        expect(report.output).toContain('gh auth login');
        expect(report.output).toContain('No issue created.');
        expect(report.output).not.toContain('/Users/example');
        expect(report.output).not.toContain('private-memory-content');
        expect(report.output).not.toContain('memoryBody');
        expect(report.output).not.toContain('sk-1234567890abcdefghijkl');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('creates an issue through gh api without putting public content in process arguments', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config, fs} = yield* reportIssueTestHome('apply');
        yield* withProductionLogging(config.agentContextHome, {component: 'cli', operation: 'doctor'}, Effect.void);
        const system = yield* SystemInfo;
        const hostileSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), GH_HOST: 'hostile.example'}),
        });
        let invocation:
          | {
              readonly args: readonly string[];
              readonly environment?: NodeJS.ProcessEnv;
              readonly executable: string;
              readonly requestPath: string;
            }
          | undefined;
        let request: {readonly body?: unknown; readonly title?: unknown} | undefined;
        let requestMode: number | undefined;
        const command = CommandExecutor.of({
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              const inputIndex = args.indexOf('--input');
              const requestPath = args[inputIndex + 1];
              invocation = {args, environment: options?.env, executable, requestPath};
              request = JSON.parse(yield* fs.readFileString(requestPath)) as {
                readonly body?: unknown;
                readonly title?: unknown;
              };
              requestMode = (yield* fs.stat(requestPath)).mode;
              return {
                exitCode: 0,
                stderr: '',
                stdout: 'https://github.com/Kashkovsky/threadnote/issues/321\n',
              };
            }).pipe(Effect.orDie),
          executeStreaming: () => Effect.succeed({exitCode: 0, stderr: '', stdout: ''}),
        });

        const options = {
          apply: false,
          body: 'The standalone command failed after installation.',
          includeLogs: true,
          title: 'Standalone command failure',
        } as const;
        const preview = yield* captureConsole(runReportIssue(config, options)).pipe(
          Effect.provideService(SystemInfo, hostileSystem),
        );
        const approval = approvalFrom(preview.output);
        const report = yield* captureConsole(
          runReportIssue(config, {
            approval,
            apply: true,
            body: options.body,
            includeLogs: options.includeLogs,
            title: options.title,
          }),
        ).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, hostileSystem));

        expect(report.output).toContain('Created GitHub issue: https://github.com/Kashkovsky/threadnote/issues/321');
        expect(invocation?.executable).toBe('gh');
        expect(invocation?.args).toEqual([
          'api',
          '--method',
          'POST',
          '--hostname',
          'github.com',
          'repos/Kashkovsky/threadnote/issues',
          '--input',
          invocation?.requestPath,
          '--jq',
          '.html_url',
        ]);
        expect(invocation?.environment?.GH_HOST).toBe('hostile.example');
        expect(invocation?.args.join(' ')).not.toContain('Standalone command failure');
        expect(invocation?.args.join(' ')).not.toContain('failed after installation');
        expect(request?.title).toBe('Standalone command failure');
        expect(request?.body).toContain('The standalone command failed after installation.');
        expect(request?.body).toContain('Production logs included: yes');
        expect(request?.body).toContain('"operation":"doctor"');
        expect((requestMode ?? 0) & 0o777).toBe(0o600);
        expect(yield* fs.exists(invocation?.requestPath as string)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses apply when logs changed after the approved preview', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config} = yield* reportIssueTestHome('approval-drift');
        yield* withProductionLogging(config.agentContextHome, {component: 'cli', operation: 'doctor'}, Effect.void);
        const base = {
          apply: false,
          body: 'The report must submit exactly the diagnostics that were reviewed.',
          includeLogs: true,
          title: 'Exact report approval',
        } as const;
        const preview = yield* captureConsole(runReportIssue(config, base));
        const approval = approvalFrom(preview.output);
        yield* withProductionLogging(config.agentContextHome, {component: 'cli', operation: 'logs'}, Effect.void);
        let commandInvoked = false;
        const command = CommandExecutor.of({
          execute: () =>
            Effect.sync(() => {
              commandInvoked = true;
              return {exitCode: 0, stderr: '', stdout: ''};
            }),
          executeStreaming: () => Effect.succeed({exitCode: 0, stderr: '', stdout: ''}),
        });

        const exit = yield* Effect.exit(
          runReportIssue(config, {...base, approval, apply: true}).pipe(
            Effect.provideService(CommandExecutor, command),
          ),
        );
        const carriageReturnExit = yield* Effect.exit(
          runReportIssue(config, {
            apply: false,
            body: 'Safe prefix\rspoofed terminal line',
            includeLogs: false,
            title: 'Unsafe carriage return',
          }).pipe(Effect.provideService(CommandExecutor, command)),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.isFailure(carriageReturnExit)).toBe(true);
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(ReportIssueInvalid);
        expect(Exit.isFailure(carriageReturnExit) ? Cause.squash(carriageReturnExit.cause) : undefined).toBeInstanceOf(
          ReportIssueInvalid,
        );
        expect(commandInvoked).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects terminal control sequences before preview or publication', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config} = yield* reportIssueTestHome('terminal-control');
        let commandInvoked = false;
        const command = CommandExecutor.of({
          execute: () =>
            Effect.sync(() => {
              commandInvoked = true;
              return {exitCode: 0, stderr: '', stdout: ''};
            }),
          executeStreaming: () => Effect.succeed({exitCode: 0, stderr: '', stdout: ''}),
        });

        const exit = yield* Effect.exit(
          runReportIssue(config, {
            apply: true,
            body: 'Failure details\u001b]8;;https://example.invalid\u0007spoofed link',
            includeLogs: false,
            title: 'Unsafe terminal report',
          }).pipe(Effect.provideService(CommandExecutor, command)),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(ReportIssueInvalid);
        expect(commandInvoked).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('blocks credential-like content before preview or publication', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config} = yield* reportIssueTestHome('secret');
        let commandInvoked = false;
        const command = CommandExecutor.of({
          execute: () =>
            Effect.sync(() => {
              commandInvoked = true;
              return {exitCode: 0, stderr: '', stdout: ''};
            }),
          executeStreaming: () => Effect.succeed({exitCode: 0, stderr: '', stdout: ''}),
        });

        const exit = yield* Effect.exit(
          runReportIssue(config, {
            apply: true,
            body: 'The request used sk-1234567890abcdefghijkl and then failed.',
            includeLogs: false,
            title: 'Credential leak test',
          }).pipe(Effect.provideService(CommandExecutor, command)),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(ReportIssueInvalid);
        expect(commandInvoked).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('explains how to install and authenticate gh when submission cannot spawn it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config} = yield* reportIssueTestHome('missing-gh');
        const command = CommandExecutor.of({
          execute: () =>
            Effect.fail(
              new CommandSpawnFailed({
                args: [],
                cause: new TestError('not found'),
                executable: 'gh',
                message: 'gh could not be started',
              }),
            ),
          executeStreaming: () => Effect.succeed({exitCode: 0, stderr: '', stdout: ''}),
        });

        const preview = yield* captureConsole(
          runReportIssue(config, {
            apply: false,
            body: 'The approved issue is ready to submit.',
            includeLogs: false,
            title: 'Submission needs GitHub CLI',
          }),
        );
        const exit = yield* Effect.exit(
          runReportIssue(config, {
            approval: approvalFrom(preview.output),
            apply: true,
            body: 'The approved issue is ready to submit.',
            includeLogs: false,
            title: 'Submission needs GitHub CLI',
          }).pipe(Effect.provideService(CommandExecutor, command)),
        );
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

        expect(error).toBeInstanceOf(ReportIssueCreateFailed);
        expect(error instanceof Error ? error.message : '').toContain('https://cli.github.com/');
        expect(error instanceof Error ? error.message : '').toContain('gh auth login');
        expect(error instanceof Error ? error.message : '').toContain('--apply');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function approvalFrom(output: string): string {
  const approval = /Approval digest: (sha256:[a-f0-9]{64})/.exec(output)?.[1];
  expect(approval).toBeDefined();
  return approval as string;
}

function reportIssueTestHome(label: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-report-issue-${label}-`});
    const home = path.join(root, 'home');
    yield* fs.makeDirectory(home, {recursive: true});
    yield* fs.writeFileString(
      path.join(home, 'layout.json'),
      `${JSON.stringify({createdBy: 'threadnote', version: 2})}\n`,
      {mode: 0o600},
    );
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: path.join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    return {config, fs, path};
  });
}
