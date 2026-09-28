export const ALLOWED_ITEM_TYPES = [
  'agentMessage',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'plan',
  'reasoning',
  'userMessage',
] as const;
export type AllowedItemType = (typeof ALLOWED_ITEM_TYPES)[number];

export const IGNORED_MATCHING_TURN_METHOD_VALUES = [
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'model/safetyBuffering/updated',
  'model/verification',
  'turn/diff/updated',
  'turn/plan/updated',
] as const;
export type IgnoredTurnMethod = (typeof IGNORED_MATCHING_TURN_METHOD_VALUES)[number];
export const IGNORED_MATCHING_TURN_METHODS = new Set<string>(IGNORED_MATCHING_TURN_METHOD_VALUES);
