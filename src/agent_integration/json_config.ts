import type {JsonObject} from '../types.js';
import {escapeRegExp, isJsonObject} from '../utils.js';

export function parseAgentJson(content: string | undefined): JsonObject {
  const value: unknown = JSON.parse(content ?? '{}');
  if (!isJsonObject(value)) throw new Error('Agent configuration must be a JSON object.');
  return value;
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
