/** Makes untrusted checkpoint labels visible without emitting terminal controls. */
export function checkpointTerminalText(value: string): string {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    output +=
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? `\\u{${codePoint.toString(16).padStart(4, '0')}}`
        : character;
  }
  return output;
}
