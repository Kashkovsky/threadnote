import {sha256HexSync} from '../../src/crypto/sha256.js';

export type PilotSplit = 'train' | 'validation' | 'test';

export interface PilotFact {
  readonly id: string;
  readonly topic: string;
  readonly query: string;
  readonly current: string;
  readonly stale: string;
}

export interface PilotMissingFact {
  readonly id: string;
  readonly topic: string;
  readonly query: string;
  readonly near: string;
  readonly otherProduct: string;
}

export interface PilotScenario {
  readonly id: string;
  readonly organization: string;
  readonly repository: string;
  readonly product: string;
  readonly split: PilotSplit;
  readonly facts: readonly PilotFact[];
  readonly missing: readonly PilotMissingFact[];
}

interface ProposalCandidate {
  readonly id: string;
  readonly language: 'en';
  readonly negativeKind?: 'no_answer_distractor' | 'random' | 'semantic_hard' | 'stale' | 'wrong_scope';
  readonly provenanceRecord: string;
  readonly relevance: 0 | 3;
  readonly reviewed: false;
  readonly sourceId: string;
  readonly text: string;
  readonly title: string;
}

interface ProposalGroup {
  readonly version: 1;
  readonly id: string;
  readonly split: PilotSplit;
  readonly answerability: 'answerable' | 'no_answer';
  readonly language: 'en';
  readonly partitionKey: string;
  readonly provenanceRecord: string;
  readonly query: string;
  readonly sourceId: string;
  readonly candidates: readonly ProposalCandidate[];
}

const SOURCE_ID = 'threadnote-owned-fictional-pilot-v1';
const GENERATOR_REVISION = 'pilot-proposal-assembly-v1';
const CREATED_AT = '2026-09-15T00:00:00.000Z';

function sha256(value: string | Uint8Array): string {
  return sha256HexSync(value);
}

function candidate(
  scenario: PilotScenario,
  id: string,
  title: string,
  text: string,
  relevance: 0 | 3,
  negativeKind?: ProposalCandidate['negativeKind'],
): ProposalCandidate {
  return {
    id: `${scenario.id}-${id}`,
    language: 'en',
    ...(negativeKind ? {negativeKind} : {}),
    provenanceRecord: `${GENERATOR_REVISION}:${scenario.id}:${id}:sha256:${sha256(text)}`,
    relevance,
    reviewed: false,
    sourceId: SOURCE_ID,
    text,
    title,
  };
}

function factDocument(
  scenario: PilotScenario,
  fact: PilotFact,
  index: number,
  relevance: 0 | 3,
  kind?: ProposalCandidate['negativeKind'],
): ProposalCandidate {
  return candidate(
    scenario,
    `${fact.id}-current-${index}`,
    `${scenario.product}: ${fact.topic}`,
    fact.current,
    relevance,
    kind,
  );
}

export function buildPilotProposalCorpusV1(
  scenarios: readonly PilotScenario[],
  seedSha256: string,
  licenseSha256: string,
) {
  if (scenarios.length === 0) throw new Error('Pilot seeds must contain scenarios.');
  const scenarioIds = new Set<string>();
  const organizationSplits = new Map<string, PilotSplit>();
  const groups: ProposalGroup[] = [];
  const inventory: Array<{id: string; split: PilotSplit; textSha256: string; text: string}> = [];

  for (const scenario of scenarios) {
    if (scenarioIds.has(scenario.id)) throw new Error(`Duplicate scenario ID: ${scenario.id}`);
    scenarioIds.add(scenario.id);
    if (!['train', 'validation', 'test'].includes(scenario.split)) throw new Error(`Invalid split: ${scenario.id}`);
    if (scenario.facts.length !== 4 || scenario.missing.length !== 2) {
      throw new Error(`Scenario ${scenario.id} must have four facts and two missing facts.`);
    }
    const previousSplit = organizationSplits.get(scenario.organization);
    if (previousSplit && previousSplit !== scenario.split) {
      throw new Error(`Organization ${scenario.organization} crosses splits.`);
    }
    organizationSplits.set(scenario.organization, scenario.split);
    const partitionKey = `fictional-org:${scenario.organization}/repository:${scenario.repository}/product:${scenario.product}`;
    const facts = scenario.facts;
    for (const [index, fact] of facts.entries()) {
      inventory.push({
        id: `${scenario.id}/${fact.id}/current`,
        split: scenario.split,
        textSha256: sha256(fact.current),
        text: fact.current,
      });
      inventory.push({
        id: `${scenario.id}/${fact.id}/stale`,
        split: scenario.split,
        textSha256: sha256(fact.stale),
        text: fact.stale,
      });
      groups.push({
        version: 1,
        id: `${scenario.id}-${fact.id}-answerable`,
        split: scenario.split,
        answerability: 'answerable',
        language: 'en',
        partitionKey,
        provenanceRecord: `${GENERATOR_REVISION}:${scenario.id}:${fact.id}:query`,
        query: fact.query,
        sourceId: SOURCE_ID,
        candidates: [
          factDocument(scenario, fact, index, 3),
          candidate(scenario, `${fact.id}-stale`, `${scenario.product}: ${fact.topic}`, fact.stale, 0, 'stale'),
          factDocument(scenario, facts[(index + 1) % facts.length], index + 1, 0, 'semantic_hard'),
          factDocument(scenario, facts[(index + 2) % facts.length], index + 2, 0, 'random'),
          candidate(
            scenario,
            `${scenario.missing[index % 2].id}-near`,
            `${scenario.product}: ${scenario.missing[index % 2].topic}`,
            scenario.missing[index % 2].near,
            0,
            'no_answer_distractor',
          ),
          candidate(
            scenario,
            `${scenario.missing[index % 2].id}-other-product`,
            `${scenario.organization}: ${scenario.missing[index % 2].topic}`,
            scenario.missing[index % 2].otherProduct,
            0,
            'wrong_scope',
          ),
        ],
      });
    }
    for (const [index, missing] of scenario.missing.entries()) {
      inventory.push({
        id: `${scenario.id}/${missing.id}/near`,
        split: scenario.split,
        textSha256: sha256(missing.near),
        text: missing.near,
      });
      inventory.push({
        id: `${scenario.id}/${missing.id}/other-product`,
        split: scenario.split,
        textSha256: sha256(missing.otherProduct),
        text: missing.otherProduct,
      });
      groups.push({
        version: 1,
        id: `${scenario.id}-${missing.id}-no-answer`,
        split: scenario.split,
        answerability: 'no_answer',
        language: 'en',
        partitionKey,
        provenanceRecord: `${GENERATOR_REVISION}:${scenario.id}:${missing.id}:query`,
        query: missing.query,
        sourceId: SOURCE_ID,
        candidates: [
          candidate(
            scenario,
            `${missing.id}-near`,
            `${scenario.product}: ${missing.topic}`,
            missing.near,
            0,
            'no_answer_distractor',
          ),
          candidate(
            scenario,
            `${missing.id}-other-product`,
            `${scenario.organization}: ${missing.topic}`,
            missing.otherProduct,
            0,
            'wrong_scope',
          ),
          factDocument(scenario, facts[index], index, 0, 'semantic_hard'),
          factDocument(scenario, facts[index + 1], index + 1, 0, 'random'),
          candidate(
            scenario,
            `${facts[index + 2].id}-stale`,
            `${scenario.product}: ${facts[index + 2].topic}`,
            facts[index + 2].stale,
            0,
            'stale',
          ),
          factDocument(scenario, facts[(index + 2) % facts.length], index + 2, 0, 'semantic_hard'),
        ],
      });
    }
  }

  groups.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  inventory.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const orderedGroups = groups.map(group => ({
    ...group,
    candidates: [...group.candidates].sort((left, right) =>
      sha256(`${group.id}:${left.id}`).localeCompare(sha256(`${group.id}:${right.id}`), 'en'),
    ),
  }));
  const groupJsonl = `${orderedGroups.map(group => JSON.stringify(group)).join('\n')}\n`;
  const inventoryJson = `${JSON.stringify(inventory, null, 2)}\n`;
  const draft = {
    createdAt: CREATED_AT,
    description: 'AI-authored fictional engineering pilot proposals; every source and label awaits human attestation.',
    generatorRevision: GENERATOR_REVISION,
    labelMethod: 'Proposed relevance, negative kind, and answerability; all candidates retain reviewed=false.',
    name: 'threadnote-reranker-fictional-pilot-proposals-v1',
    partitionStrategy:
      'Whole fictional organizations assigned to train, validation, or test; no source-text templates.',
    privacyReviewed: false,
    purpose: 'training_candidate',
    seed: 20260915,
    sources: [
      {
        id: SOURCE_ID,
        kind: 'self_authored_synthetic',
        license: 'AGPL-3.0-or-later',
        licenseUrl: 'https://github.com/Kashkovsky/threadnote/blob/9f50c64dd491b0ab3b847884b0cb3afa47ea3b2d/LICENSE',
        privacyBasis: 'self_authored',
        provenance: `Fictional seed file training/recall-reranker/dataset-tools/pilot-v1/seeds.json; seed sha256 ${seedSha256}; source inventory sha256 ${sha256(inventoryJson)}; license sha256 ${licenseSha256}; assembly ${GENERATOR_REVISION}.`,
        redistributionApproved: false,
        revision: `sha256:${seedSha256}`,
        sourceUri: `urn:sha256:${seedSha256}`,
        trainingApproved: false,
      },
    ],
  };
  const counts = {
    groups: orderedGroups.length,
    candidates: orderedGroups.reduce((sum, group) => sum + group.candidates.length, 0),
    noAnswerGroups: orderedGroups.filter(group => group.answerability === 'no_answer').length,
    splits: {
      train: orderedGroups.filter(group => group.split === 'train').length,
      validation: orderedGroups.filter(group => group.split === 'validation').length,
      test: orderedGroups.filter(group => group.split === 'test').length,
    },
    organizations: organizationSplits.size,
    seedSha256,
    inventorySha256: sha256(inventoryJson),
    groupFileSha256: sha256(groupJsonl),
  };
  return {groups: orderedGroups, groupJsonl, inventory, inventoryJson, draft, counts};
}

if (import.meta.main) {
  const output = 'training/recall-reranker/dataset-tools/pilot-v1';
  const seedBytes = await Bun.file(`${output}/seeds.json`).bytes();
  const licenseBytes = await Bun.file('LICENSE').bytes();
  const corpus = buildPilotProposalCorpusV1(
    JSON.parse(new TextDecoder().decode(seedBytes)) as PilotScenario[],
    sha256(seedBytes),
    sha256(licenseBytes),
  );
  for (const [file, content] of [
    ['groups.proposed.jsonl', corpus.groupJsonl],
    ['source-inventory.json', corpus.inventoryJson],
    ['draft.proposed.json', `${JSON.stringify(corpus.draft, null, 2)}\n`],
    ['counts.json', `${JSON.stringify(corpus.counts, null, 2)}\n`],
  ] as const) {
    await Bun.write(`${output}/${file}`, content);
  }
  await Bun.write(
    Bun.stdout,
    `Built ${corpus.counts.groups} unreviewed groups and ${corpus.counts.candidates} candidates.\n`,
  );
}
