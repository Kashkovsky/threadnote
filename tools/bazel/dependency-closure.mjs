export function dependencyClosure(start, dependencies) {
  const visited = new Set();
  const pending = [start];
  while (pending.length) {
    const key = pending.pop();
    if (visited.has(key)) continue;
    visited.add(key);
    pending.push(...dependencies(key));
  }
  return [...visited].sort();
}
