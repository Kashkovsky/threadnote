import {Option} from 'effect';
import type {ConsolidationAgent, MemoryKind, MemoryStatus} from '../types.js';

class ManagerRequestInputError extends Error {
  override readonly name = 'ManagerRequestInputError';
}

export function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new ManagerRequestInputError(`Missing query parameter: ${name}`);
  return value;
}

export function optionalPositiveIntegerQuery(url: URL, name: string): Option.Option<number> {
  return Option.fromNullishOr(url.searchParams.get(name)).pipe(
    Option.map(value => Number(value)),
    Option.filter(value => Number.isSafeInteger(value) && value > 0),
  );
}

export function optionalNonNegativeIntegerQuery(url: URL, name: string): Option.Option<number> {
  return Option.fromNullishOr(url.searchParams.get(name)).pipe(
    Option.map(value => Number(value)),
    Option.filter(value => Number.isSafeInteger(value) && value >= 0),
  );
}

export function optionalNonEmptyQuery(url: URL, name: string): Option.Option<string> {
  return Option.fromNullishOr(url.searchParams.get(name)).pipe(
    Option.map(value => value.trim()),
    Option.filter(value => value.length > 0),
  );
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ManagerRequestInputError(`Provide ${name}.`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function requireStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string')) {
    throw new ManagerRequestInputError(`Provide ${name} as a non-empty string array.`);
  }
  return value;
}

export function requireConfirm(body: Record<string, unknown>): void {
  if (body.confirm !== true) throw new ManagerRequestInputError('Set confirm=true for this action.');
}

export function memoryKind(value: unknown): MemoryKind | undefined {
  return value === 'durable' ||
    value === 'handoff' ||
    value === 'incident' ||
    value === 'preference' ||
    value === 'smoke'
    ? value
    : undefined;
}

export function memoryStatus(value: unknown): MemoryStatus | undefined {
  return value === 'active' || value === 'archived' || value === 'expired' || value === 'superseded'
    ? value
    : undefined;
}

export function consolidationAgent(value: string): ConsolidationAgent {
  if (value === 'codex' || value === 'claude' || value === 'cursor' || value === 'copilot' || value === 'effect-ai') {
    return value;
  }
  throw new ManagerRequestInputError(`Unsupported consolidation agent: ${value}`);
}

export function cleanupMode(value: unknown): 'archive' | 'forget' | 'keep' {
  return value === 'forget' || value === 'keep' ? value : 'archive';
}
