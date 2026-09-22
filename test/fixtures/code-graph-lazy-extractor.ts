import {extractFileFacts} from '../../src/code_graph/extractor.js';

const content = 'export function bundledExample() { return 1; }';
const facts = extractFileFacts({
  blobId: 'b'.repeat(40),
  content,
  contentHash: 'a'.repeat(64),
  language: 'typescript',
  mode: '100644',
  path: 'src/example.ts',
  size: Buffer.byteLength(content),
  source: 'commit',
});
process.stdout.write(JSON.stringify(facts.symbols.map(symbol => symbol.name)) + '\n');
