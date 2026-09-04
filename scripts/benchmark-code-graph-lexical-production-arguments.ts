import {ScriptError} from './effect/errors.js';
import {Option} from 'effect';

const DEFAULT_SYMBOL_COUNT = 5_000;
const DEFAULT_BATCH_SYMBOLS = 1_000;
const DEFAULT_QUERY_ITERATIONS = 20;
const MAXIMUM_SYMBOLS_WITHOUT_LARGE_OPT_IN = 50_000;
const MAXIMUM_SYMBOLS = 200_000;

export interface LexicalProductionBenchmarkArguments {
  readonly allowLarge: boolean;
  readonly batchSymbols: number;
  readonly outputPath: Option.Option<string>;
  readonly queryIterations: number;
  readonly symbolCount: number;
}

export function parseLexicalProductionBenchmarkArguments(
  arguments_: readonly string[],
): LexicalProductionBenchmarkArguments {
  const outputIndex = arguments_.indexOf('--output');
  const symbolCount = integerArgument(arguments_, '--symbols', DEFAULT_SYMBOL_COUNT);
  const allowLarge = arguments_.includes('--allow-large');
  if (symbolCount > MAXIMUM_SYMBOLS || (symbolCount > MAXIMUM_SYMBOLS_WITHOUT_LARGE_OPT_IN && !allowLarge)) {
    throw ScriptError.make({
      message: `--symbols must be at most ${MAXIMUM_SYMBOLS_WITHOUT_LARGE_OPT_IN} without --allow-large and ${MAXIMUM_SYMBOLS} overall.`,
    });
  }
  let outputPath = Option.none<string>();
  if (outputIndex !== -1) {
    const value = arguments_[outputIndex + 1];
    if (!value) throw ScriptError.make({message: '--output requires a path.'});
    outputPath = Option.some(value);
  }
  return {
    allowLarge,
    batchSymbols: integerArgument(arguments_, '--batch-symbols', DEFAULT_BATCH_SYMBOLS),
    outputPath,
    queryIterations: integerArgument(arguments_, '--query-iterations', DEFAULT_QUERY_ITERATIONS),
    symbolCount,
  };
}

function integerArgument(arguments_: readonly string[], name: string, fallback: number): number {
  const index = arguments_.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(arguments_[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw ScriptError.make({message: `${name} requires a positive integer.`});
  return value;
}
