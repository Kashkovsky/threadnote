export function globToRegExp(glob: string): RegExp {
  let output = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      const next = glob[index + 1];
      if (next === '*') {
        const afterNext = glob[index + 2];
        if (afterNext === '/') {
          output += '(?:.*/)?';
          index += 2;
        } else {
          output += '.*';
          index += 1;
        }
      } else {
        output += '[^/]*';
      }
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += escapeRegExp(char);
    }
  }
  output += '$';
  return new RegExp(output);
}

export function getGlobBase(pattern: string): string {
  const parts = pattern.split('/');
  const baseParts: string[] = [];
  for (const part of parts) {
    if (hasGlob(part)) break;
    baseParts.push(part);
  }
  return baseParts.length === 0 ? '.' : baseParts.join('/');
}

export function hasGlob(path: string): boolean {
  return path.includes('*') || path.includes('?');
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
