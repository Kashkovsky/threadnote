import {createTextStructuralLanguagePack} from '../text_structural/factory.js';

export const codeGraphLanguagePack = createTextStructuralLanguagePack({
  capabilities: new Set(['declarations', 'dependencies', 'imports', 'inheritance']),
  files: [
    {kind: 'extension', language: 'razor', role: 'source', value: '.razor'},
    {kind: 'extension', language: 'razor', role: 'source', value: '.cshtml'},
  ],
  id: 'razor',
  resolutionDomain: 'dotnet',
  version: '1.0.0-text-structural',
});
