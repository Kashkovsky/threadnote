import type {PilotInput} from '@threadnote/threadnote/value_report/pilot/contract';

export function pilotInput(): PilotInput {
  return {
    schema: 'threadnote.value-pilot-input.v1',
    version: 1,
    windowStart: '2026-08-03',
    elapsedDays: 28,
    actors: 3,
    sources: [],
    observations: [],
    evidence: [],
    evidenceCoverage: 'partial',
  };
}
