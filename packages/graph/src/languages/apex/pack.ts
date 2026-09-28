import {createTextStructuralLanguagePack} from '../text_structural/factory.js';

export const codeGraphLanguagePack = createTextStructuralLanguagePack({
  capabilities: new Set(['declarations', 'dependencies', 'inheritance']),
  files: [
    {kind: 'extension', language: 'apex', role: 'source', value: '.cls'},
    {kind: 'extension', language: 'apex-trigger', role: 'source', value: '.trigger'},
  ],
  id: 'apex',
  resolutionDomain: 'apex',
  version: '1.0.0-text-structural',
});
