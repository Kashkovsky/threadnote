import {createTextStructuralLanguagePack} from '../text_structural/factory.js';

export const codeGraphLanguagePack = createTextStructuralLanguagePack({
  capabilities: new Set(['calls', 'declarations', 'imports']),
  files: [
    {kind: 'extension', language: 'fortran', role: 'source', value: '.f'},
    {kind: 'extension', language: 'fortran', role: 'source', value: '.for'},
    {kind: 'extension', language: 'fortran', role: 'source', value: '.f77'},
    {kind: 'extension', language: 'fortran', role: 'source', value: '.f90'},
    {kind: 'extension', language: 'fortran', role: 'source', value: '.f95'},
    {kind: 'extension', language: 'fortran', role: 'source', value: '.f03'},
    {kind: 'extension', language: 'fortran', role: 'source', value: '.f08'},
  ],
  id: 'fortran',
  resolutionDomain: 'fortran',
  version: '1.0.0-text-structural',
});
