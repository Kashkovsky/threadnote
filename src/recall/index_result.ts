import {Predicate, Schema} from 'effect';
import {MEMORY_RELATION_TYPES} from '../memory/document.js';
import type {RecallCodeLinkMatch} from './code_links.js';
import type {RecallExactMatch, RecallIndexData} from './index.js';
import type {RecallMemoryLinkMatch} from './memory_links.js';

class RecallIndexOperationError extends Schema.TaggedError<RecallIndexOperationError>()('RecallIndexOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export function recallIndexDataResult(value: unknown): RecallIndexData {
  if (!isRecallIndexData(value)) {
    throw RecallIndexOperationError.make({message: 'Recall index returned an unexpected data result.'});
  }
  return value;
}

function isRecallIndexData(value: unknown): value is RecallIndexData {
  return (
    Predicate.isObject(value) &&
    Array.isArray(value.candidates) &&
    Predicate.isObject(value.corpusStatistics) &&
    typeof value.generation === 'string' &&
    typeof value.queryExhaustive === 'boolean' &&
    (value.recentCandidates === undefined || Array.isArray(value.recentCandidates))
  );
}

export function recallIndexDataBatchResult(value: unknown): readonly RecallIndexData[] {
  if (!Array.isArray(value))
    throw RecallIndexOperationError.make({message: 'Recall index returned an unexpected batch result.'});
  return value.map(recallIndexDataResult);
}

export function recallExactMatchesResult(value: unknown): readonly RecallExactMatch[] {
  if (!Array.isArray(value))
    throw RecallIndexOperationError.make({message: 'Recall index returned an unexpected exact-match result.'});
  return value.map(entry => {
    if (
      !Predicate.isObject(entry) ||
      !Array.isArray(entry.terms) ||
      !entry.terms.every(term => typeof term === 'string') ||
      typeof entry.uri !== 'string'
    ) {
      throw RecallIndexOperationError.make({message: 'Recall index returned an invalid exact match.'});
    }
    return {terms: entry.terms, uri: entry.uri};
  });
}

export function recallCodeLinkMatchesResult(value: unknown): readonly RecallCodeLinkMatch[] {
  if (!Array.isArray(value))
    throw RecallIndexOperationError.make({message: 'Recall index returned an unexpected code-link result.'});
  return value.map(entry => {
    if (
      !Predicate.isObject(entry) ||
      !isSafeInteger(entry.anchorOrdinal) ||
      typeof entry.citationId !== 'string' ||
      !isSafeInteger(entry.citationOrdinal) ||
      !isOneOf(entry.matchKind, ['file-content', 'file-path', 'symbol-locator', 'symbol-node']) ||
      typeof entry.uri !== 'string'
    ) {
      throw RecallIndexOperationError.make({message: 'Recall index returned an invalid code link.'});
    }
    return {
      anchorOrdinal: entry.anchorOrdinal,
      citationId: entry.citationId,
      citationOrdinal: entry.citationOrdinal,
      matchKind: entry.matchKind,
      uri: entry.uri,
    };
  });
}

export function recallMemoryLinkMatchesResult(value: unknown): readonly RecallMemoryLinkMatch[] {
  if (!Array.isArray(value))
    throw RecallIndexOperationError.make({message: 'Recall index returned an unexpected memory-link result.'});
  return value.map(entry => {
    if (
      !Predicate.isObject(entry) ||
      !isOneOf(entry.direction, ['incoming', 'outgoing']) ||
      !isSafeInteger(entry.relationOrdinal) ||
      !isOneOf(entry.relationOrigin, ['evidence', 'references', 'relation', 'supersedes']) ||
      !isOneOf(entry.relationType, MEMORY_RELATION_TYPES) ||
      !isSafeInteger(entry.requestedOrdinal) ||
      typeof entry.sourceMemoryId !== 'string' ||
      typeof entry.sourceUri !== 'string' ||
      (entry.targetMemoryId !== undefined && typeof entry.targetMemoryId !== 'string')
    ) {
      throw RecallIndexOperationError.make({message: 'Recall index returned an invalid memory link.'});
    }
    return {
      direction: entry.direction,
      relationOrdinal: entry.relationOrdinal,
      relationOrigin: entry.relationOrigin,
      relationType: entry.relationType,
      requestedOrdinal: entry.requestedOrdinal,
      sourceMemoryId: entry.sourceMemoryId,
      sourceUri: entry.sourceUri,
      ...(entry.targetMemoryId === undefined ? {} : {targetMemoryId: entry.targetMemoryId}),
    };
  });
}

function isOneOf<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
  return typeof value === 'string' && values.some(candidate => candidate === value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
