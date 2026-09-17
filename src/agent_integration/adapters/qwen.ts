import {defineJsonAgentAdapter} from '../surfaces.js';

export const qwenAdapter = defineJsonAgentAdapter('qwen-code', {
  root: '.qwen',
  mcpFile: 'settings.json',
  container: 'mcpServers',
  instructionFile: 'QWEN.md',
  skillRoot: 'native',
  policyGlobs: true,
});
