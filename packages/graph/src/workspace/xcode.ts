export function xcodeNativeTargetNames(content: string): readonly string[] {
  const targets: string[] = [];
  let nativeTarget = false;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const equals = line.indexOf('=');
    const semicolon = line.indexOf(';', equals + 1);
    if (equals < 0 || semicolon < 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1, semicolon).trim();
    if (key === 'isa') {
      nativeTarget = value === 'PBXNativeTarget';
      continue;
    }
    if (!nativeTarget || key !== 'name') continue;
    const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    if (unquoted) targets.push(unquoted);
    nativeTarget = false;
  }
  return targets;
}
