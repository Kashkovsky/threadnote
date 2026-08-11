const UNSAFE_JAVASCRIPT_STRING_CHARACTER = /[<>\u2028\u2029]/g;
const JAVASCRIPT_CHARACTER_ESCAPE = {
  '<': '\\u003c',
  '>': '\\u003e',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
} as const;

type UnsafeJavascriptStringCharacter = keyof typeof JAVASCRIPT_CHARACTER_ESCAPE;

export function javascriptStringLiteral(value: string): string {
  return JSON.stringify(value).replace(
    UNSAFE_JAVASCRIPT_STRING_CHARACTER,
    character => JAVASCRIPT_CHARACTER_ESCAPE[character as UnsafeJavascriptStringCharacter],
  );
}

export function optionalNativePackageFallbackModule(): string {
  return "export const getBinsDir = () => { throw new Error('Optional native package is not included in this Threadnote artifact.'); };";
}
