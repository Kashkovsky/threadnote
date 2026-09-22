import type ts from 'typescript-compiler';

/** Synchronous parser-only loading; the literal module specifier stays visible to Bun's bundler. */
export function loadTypeScriptExtractionRuntime(): {
  readonly compiler: typeof ts;
  readonly declarationKinds: ReadonlySet<ts.SyntaxKind>;
} {
  const compiler: typeof ts = require('typescript-compiler');
  return {
    compiler,
    declarationKinds: new Set([
      compiler.SyntaxKind.ClassDeclaration,
      compiler.SyntaxKind.EnumDeclaration,
      compiler.SyntaxKind.FunctionDeclaration,
      compiler.SyntaxKind.InterfaceDeclaration,
      compiler.SyntaxKind.TypeAliasDeclaration,
    ]),
  };
}

export function typeScriptKindForPath(compiler: typeof ts, path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return compiler.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return compiler.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return compiler.ScriptKind.JS;
  return compiler.ScriptKind.TS;
}
