import {Language, Parser} from 'web-tree-sitter';
import {fileURLToPath} from 'node:url';

declare const self: Worker;

self.onmessage = async event => {
  await Parser.init({
    locateFile: () => fileURLToPath(import.meta.resolve('web-tree-sitter/web-tree-sitter.wasm')),
  });
  const language = await Language.load(
    fileURLToPath(
      new URL('../../../node_modules/@repomix/tree-sitter-wasms/out/tree-sitter-typescript.wasm', import.meta.url),
    ),
  );
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(event.data);
  self.postMessage(tree?.rootNode.type);
  tree?.delete();
  parser.delete();
};
