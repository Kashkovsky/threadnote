import {Option} from 'effect';
import type {TreeSitterImport, TreeSitterReferenceInput, TreeSitterSymbolInput} from '../../tree_sitter/extractor.js';

export function jvmSymbolLookupKeys(input: TreeSitterSymbolInput): readonly string[] {
  const keys = [`jvm:q:${input.qualifiedName}`];
  if (Option.isSome(input.arity)) keys.unshift(`jvm:q:${input.qualifiedName}#${input.arity.value}`);
  return keys;
}

export function jvmReferenceLookupTiers(input: TreeSitterReferenceInput): readonly (readonly string[])[] {
  if (input.relation === 'imports') {
    return input.targetName.endsWith('.*') ? [] : withArity(`jvm:q:${input.targetName}`, input.arity);
  }
  const target = input.targetName.replace(/\?$/, '');
  if (!target || /^(?:super|this)(?:\.|$)/.test(target)) return [];
  const namespace = Option.getOrUndefined(input.metadata.namespace);
  const ownerType = ownerTypeName(input.owner.qualifiedName, namespace);
  const tiers: string[][] = [];

  if (target.includes('.')) {
    const [head, ...tail] = target.split('.');
    const imported = importForLocalName(input.metadata.imports, head);
    if (Option.isSome(imported)) {
      tiers.push(...withArity(`jvm:q:${[imported.value.module, ...tail].join('.')}`, input.arity));
    } else if (/^[A-Z]/.test(head)) {
      tiers.push(...withArity(`jvm:q:${namespace ? `${namespace}.` : ''}${target}`, input.arity));
    }
    return tiers;
  }

  if (ownerType && ['calls', 'constructs', 'overrides', 'references'].includes(input.relation)) {
    tiers.push(...withArity(`jvm:q:${ownerType}.${target}`, input.arity));
  }
  const imported = importForLocalName(input.metadata.imports, target);
  if (Option.isSome(imported)) tiers.push(...withArity(`jvm:q:${imported.value.module}`, input.arity));
  if (namespace) tiers.push(...withArity(`jvm:q:${namespace}.${target}`, input.arity));
  return deduplicateTiers(tiers);
}

export function parseJvmImport(value: string): Option.Option<TreeSitterImport> {
  const withoutKeywords = value
    .replace(/^\s*import\s+/, '')
    .replace(/^\s*static\s+/, '')
    .replace(/[;\s]+$/g, '')
    .trim();
  if (!withoutKeywords) return Option.none();
  const aliasMatch = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(withoutKeywords);
  const module = (aliasMatch ? withoutKeywords.slice(0, aliasMatch.index) : withoutKeywords).trim();
  const wildcard = module.endsWith('.*');
  const importedName = wildcard ? Option.none<string>() : Option.some(module.split('.').at(-1)!);
  return Option.some({
    alias: aliasMatch ? Option.some(aliasMatch[1]) : Option.none(),
    importedName,
    module,
    wildcard,
  });
}

export function parseJvmNamespace(value: string): Option.Option<string> {
  const namespace = value
    .replace(/^\s*package\s+/, '')
    .replace(/[;\s]+$/g, '')
    .trim();
  return namespace ? Option.some(namespace) : Option.none();
}

function importForLocalName(imports: readonly TreeSitterImport[], name: string): Option.Option<TreeSitterImport> {
  const candidates = imports.filter(item => {
    const localName = Option.getOrElse(item.alias, () => Option.getOrElse(item.importedName, () => ''));
    return !item.wildcard && localName === name;
  });
  return candidates.length === 1 ? Option.some(candidates[0]) : Option.none();
}

function ownerTypeName(qualifiedName: string, namespace: string | undefined): string | undefined {
  const withoutNamespace = namespace ? qualifiedName.replace(`${namespace}.`, '') : qualifiedName;
  const components = withoutNamespace.split('.');
  if (components.length <= 1) return undefined;
  const owner = components.slice(0, -1).join('.');
  return namespace ? `${namespace}.${owner}` : owner;
}

function withArity(key: string, arity: Option.Option<number>): readonly string[][] {
  return Option.isSome(arity) ? [[`${key}#${arity.value}`], [key]] : [[key]];
}

function deduplicateTiers(tiers: readonly (readonly string[])[]): readonly (readonly string[])[] {
  const seen = new Set<string>();
  return tiers.flatMap(tier => {
    const unique = tier.filter(key => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.length > 0 ? [unique] : [];
  });
}
