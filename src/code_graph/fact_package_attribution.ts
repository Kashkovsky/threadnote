import type {CodeGraphFileFacts} from './types.js';

/** Memoizes package lookup per unique symbol path for one attribution batch. */
export function attributeFactPackages(
  facts: readonly CodeGraphFileFacts[],
  resolvePackageName: (path: string) => string | undefined,
): readonly CodeGraphFileFacts[] {
  const packageNamesByPath = new Map<string, string | null>();
  const packageNameForPath = (path: string): string | undefined => {
    const cached = packageNamesByPath.get(path);
    if (cached !== undefined) return cached ?? undefined;
    const packageName = resolvePackageName(path);
    packageNamesByPath.set(path, packageName ?? null);
    return packageName;
  };
  return facts.map(file => ({
    ...file,
    symbols: file.symbols.map(symbol => {
      const packageName = packageNameForPath(symbol.path);
      if (symbol.packageName === packageName) return symbol;
      const {packageName: _stalePackageName, ...withoutPackage} = symbol;
      return packageName ? {...withoutPackage, packageName} : withoutPackage;
    }),
  }));
}
