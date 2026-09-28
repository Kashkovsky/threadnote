import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ResolvedEffectAiConfiguration} from '../../effect/ai/consolidator.js';
import {formatJevSelectionReceipt, type JevConfiguration} from '../../effect/ai/jev.js';
import {selectExpandedRecallCandidatesEffect} from '../../effect/ai/recall.js';
import {type RecallSelectionInput} from '@threadnote/recall/selection';

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
