import {ampAdapter} from './amp.js';
import {factoryAdapter} from './factory.js';
import {geminiAdapter} from './gemini.js';
import {legacyAdapterDefinitions} from './legacy.js';
import {qwenAdapter} from './qwen.js';

export const managedAgentAdapterDefinitions = [
  ...legacyAdapterDefinitions,
  geminiAdapter,
  qwenAdapter,
  ampAdapter,
  factoryAdapter,
] as const;

export {LEGACY_ARTIFACT_TARGETS} from './legacy.js';
export type {AgentAdapter, AgentAdapterDefinition, JsonAgentStrategy} from './contract.js';
