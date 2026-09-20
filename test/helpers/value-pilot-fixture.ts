import type {PilotInput} from '../../src/value_report/pilot/contract.js';

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
