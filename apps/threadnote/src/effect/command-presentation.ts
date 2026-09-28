import {Console, Effect} from 'effect';
import {command as commandText, info, warning} from '../cli_ui.js';
import {formatShellCommand, runCommandEffect, type CommandOptions} from '@threadnote/platform/command';

export const maybeRunEffect = Effect.fn('maybeRunEffect')(function* (
  dryRun: boolean,
  executable: string,
  args: readonly string[],
  options: Pick<CommandOptions, 'allowFailure' | 'cwd' | 'timeoutMs'> = {},
) {
  const cwdSuffix = options.cwd ? ` (cwd: ${options.cwd})` : '';
  const label = dryRun ? warning('Would run') : info('Running');
  yield* Console.log(`${label}: ${commandText(formatShellCommand(executable, args))}${cwdSuffix}`);
  if (dryRun) return undefined;
  const result = yield* runCommandEffect(executable, args, options);
  if (result.stdout.trim()) yield* Console.log(result.stdout.trim());
  if (result.stderr.trim()) yield* Console.error(result.stderr.trim());
  return result;
});
