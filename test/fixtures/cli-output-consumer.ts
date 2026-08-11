import {TestError} from '../helpers/test-error.js';
const mode = process.argv[2];
const startMarker = process.argv[3] ?? 'generic-output-start';
const endMarker = process.argv[4] ?? 'generic-output-end';
const text = await new Response(Bun.stdin.stream()).text();

const result = (() => {
  if (mode === 'json') {
    const value = JSON.parse(text) as {readonly nodes?: readonly {readonly name?: string}[]};
    const nodes = value.nodes ?? [];
    return {
      allNamesMatched: nodes.every(node => node.name?.startsWith('pipedOutputSymbol')),
      bytes: new TextEncoder().encode(text).byteLength,
      nodeCount: nodes.length,
    };
  }
  if (mode === 'text') {
    return {
      bytes: new TextEncoder().encode(text).byteLength,
      hasEnd: text.includes(endMarker),
      hasStart: text.includes(startMarker),
    };
  }
  throw new TestError(`Unsupported CLI output consumer mode: ${mode ?? '<missing>'}`);
})();

await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
