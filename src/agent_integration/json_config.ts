import type {JsonObject} from '../types.js';
import {applyEdits, createScanner, modify, parse, stripComments, SyntaxKind, type ParseError} from 'jsonc-parser';
import {escapeRegExp, isJsonObject} from '../utils.js';

export function parseAgentJson(content: string | undefined, codec: 'json' | 'jsonc' = 'json'): JsonObject {
  const errors: ParseError[] = [];
  const value: unknown =
    codec === 'jsonc' ? parse(content ?? '{}', errors, {allowTrailingComma: true}) : JSON.parse(content ?? '{}');
  if (errors.length > 0) throw new Error('Agent configuration contains invalid JSONC.');
  if (!isJsonObject(value)) throw new Error('Agent configuration must be a JSON object.');
  return value;
}

export function writeAgentServer(
  content: string | undefined,
  codec: 'json' | 'jsonc',
  container: string,
  name: string,
  next: JsonObject,
): string {
  if (codec === 'json') return `${JSON.stringify(next, undefined, 2)}\n`;
  const raw = content ?? '{}\n';
  const servers = next[container];
  const target = isJsonObject(servers) ? [container, name] : [container];
  const value = isJsonObject(servers) ? servers[name] : undefined;
  const current = parseAgentJson(raw, codec)[container];
  const updated = patchJsoncValue(
    raw,
    target,
    isJsonObject(servers) && isJsonObject(current) ? current[name] : current,
    value,
  );
  return preserveJsoncComments(raw, updated);
}

export function agentJsonHasComments(content: string): boolean {
  return stripComments(content) !== content;
}

function preserveJsoncComments(original: string, updated: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const remaining = jsoncComments(updated);
  const missing = jsoncComments(original).filter(comment => {
    const index = remaining.indexOf(comment);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
  return missing.length === 0 ? updated : `${missing.join(eol)}${eol}${updated}`;
}

function jsoncComments(content: string): string[] {
  const scanner = createScanner(content, false);
  const comments: string[] = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset();
      comments.push(content.slice(offset, offset + scanner.getTokenLength()));
    }
  }
  return comments;
}

function patchJsoncValue(raw: string, target: string[], current: unknown, next: unknown): string {
  if (JSON.stringify(current) === JSON.stringify(next)) return raw;
  if (isJsonObject(current) && isJsonObject(next)) {
    let updated = raw;
    for (const key of new Set([...Object.keys(current), ...Object.keys(next)]))
      updated = patchJsoncValue(updated, [...target, key], current[key], next[key]);
    return updated;
  }
  return applyEdits(
    raw,
    modify(raw, target, next, {
      formattingOptions: {insertSpaces: true, tabSize: 2, eol: raw.includes('\r\n') ? '\r\n' : '\n'},
    }),
  );
}

export function mergeAgentServer(
  config: JsonObject,
  containerKey: string,
  name: string,
  entry: JsonObject,
): JsonObject {
  const container = config[containerKey];
  if (container !== undefined && !isJsonObject(container)) throw new Error(`Expected an object at ${containerKey}.`);
  return {...config, [containerKey]: {...(container ?? {}), [name]: entry}};
}

export function removeAgentServer(
  config: JsonObject,
  containerKey: string,
  name: string,
  createdContainer: boolean,
): JsonObject {
  const container = config[containerKey];
  if (!isJsonObject(container)) return config;
  const nextContainer = {...container};
  delete nextContainer[name];
  const next = {...config, [containerKey]: nextContainer};
  if (createdContainer && Object.keys(nextContainer).length === 0) delete next[containerKey];
  return next;
}

export function jsonServerDisabled(
  config: JsonObject,
  containerKey: string,
  name: string,
  policyGlobs = false,
): boolean {
  const container = config[containerKey];
  const entry = isJsonObject(container) ? container[name] : undefined;
  const server = isJsonObject(entry) ? entry : {};
  const policy = isJsonObject(config.mcp) ? config.mcp : {};
  const matches = (value: unknown) =>
    typeof value === 'string' &&
    (policyGlobs
      ? new RegExp(
          `^${value
            .split('*')
            .map(part => part.split('?').map(escapeRegExp).join('.'))
            .join('.*')}$`,
        ).test(name)
      : value === name);
  return (
    server.disabled === true ||
    server.enabled === false ||
    [config.disabledServers, policy.excluded, policy.excludedServers].some(
      value => Array.isArray(value) && value.some(matches),
    ) ||
    [policy.allowed, policy.allowedServers].some(value => Array.isArray(value) && !value.some(matches))
  );
}
