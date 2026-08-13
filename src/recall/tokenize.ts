const RECALL_TOKEN_PATTERN =
  /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}]|[._/'\u02bc\u2010-\u2015\u2019\u2212-](?=[\p{L}\p{N}]))*/gu;
const RECALL_CONNECTOR_PATTERN = /[._/'\u02bc\u2010-\u2015\u2019\u2212-]+/u;

/**
 * Extract human-language and identifier-shaped tokens without discarding
 * non-ASCII scripts. Tokens retain their original casing for callers such as
 * exact substring search, while NFC keeps canonically equivalent input stable.
 */
export function recallTokens(value: string): readonly string[] {
  return [...value.normalize('NFC').matchAll(RECALL_TOKEN_PATTERN)]
    .map(match => match[0])
    .filter(token => {
      const characters = [...token];
      return (
        characters.length >= 3 ||
        (characters.length === 2 &&
          /\p{L}/u.test(token) &&
          characters.some(character => (character.codePointAt(0) ?? 0) > 0x7f))
      );
    });
}

/**
 * Produce normalized lexical terms plus the components of compound identifiers.
 * Apostrophe and dash variants share one canonical form, so Ukrainian words and
 * hyphenated identifiers match even when clients use different typography.
 */
export function recallLexicalTerms(value: string): readonly string[] {
  return recallTokens(value).flatMap(token => {
    const canonical = canonicalizeConnectors(token);
    const normalized = canonical.toLowerCase();
    const components = canonical
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .split(RECALL_CONNECTOR_PATTERN)
      .map(term => term.toLowerCase())
      .filter(term => [...term].length >= 2 && term !== normalized);
    return [normalized, ...components];
  });
}

function canonicalizeConnectors(value: string): string {
  return value.replace(/[\u02bc\u2019]/gu, "'").replace(/[\u2010-\u2015\u2212]/gu, '-');
}
