import {Effect} from 'effect';
import type {RuntimeConfig} from '../../types.js';
import type {ResolvedEffectAiConfiguration} from '../../effect/ai/consolidator.js';
import {formatJevSelectionReceipt, type JevConfiguration} from '../../effect/ai/jev.js';
import {selectExpandedRecallCandidatesEffect, type RecallSelectionInput} from '../../effect/ai/recall.js';

export function makeMcpRecallCandidateSelector(
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  effectAi: ResolvedEffectAiConfiguration | undefined,
  jev: JevConfiguration | undefined,
  sections: string[],
) {
  return (input: RecallSelectionInput) =>
    selectExpandedRecallCandidatesEffect(input, config, effectAi, jev, receipt =>
      Effect.sync(() => sections.push(formatJevSelectionReceipt(receipt))),
    );
}
