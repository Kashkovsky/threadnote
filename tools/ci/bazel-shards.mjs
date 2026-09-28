/**
 * @typedef {{
 *   label: string;
 *   kind: string;
 *   entries?: readonly string[];
 *   inputs?: readonly string[];
 *   requiresNetwork?: boolean;
 *   timeout?: string | null;
 * }} BazelTarget
 */

/**
 * @param {BazelTarget} target
 */
function targetWeight(target) {
  const entryWeight = Math.max(target.entries?.length ?? 0, 1);
  const inputWeight = Math.max(Math.ceil((target.inputs?.length ?? 0) / 80), 1);
  const timeoutWeight = target.timeout === 'long' ? 20 : 0;
  const actionWeight = target.kind === 'action' ? 10 : 0;
  return Math.max(entryWeight, inputWeight) + timeoutWeight + actionWeight;
}

/**
 * @param {string} label
 */
function targetName(label) {
  if (label === '//apps/threadnote:test') return 'threadnote tests';
  if (label.startsWith('//apps/threadnote:test_long_')) return label.slice('//apps/threadnote:test_long_'.length);
  if (label === '//apps/threadnote:test_postgres') return 'postgres tests';
  if (label.startsWith('//packages/graph:')) return 'graph tests';
  if (label.startsWith('//apps/website:')) return 'website';
  if (label.startsWith('//packages/')) return 'package tests';
  if (label.startsWith('//infra/')) return 'infrastructure';
  return 'repository checks';
}

/**
 * Deterministically balances executable Bazel targets across independent CI
 * runners. Network targets stay together so ordinary shards do not pay for a
 * PostgreSQL service they cannot use.
 *
 * @param {{inventory: readonly BazelTarget[]; selected: readonly string[]; maxShards?: number}} input
 */
export function planBazelShards({inventory, selected, maxShards = 8}) {
  if (!Number.isSafeInteger(maxShards) || maxShards < 1) throw new Error('maxShards must be a positive integer');

  const selectedLabels = new Set(selected);
  const executable = inventory
    .filter(target => selectedLabels.has(target.label) && (target.kind === 'action' || target.kind === 'test'))
    .map(target => ({...target, weight: targetWeight(target)}));
  const network = executable.filter(target => target.requiresNetwork);
  const ordinary = executable.filter(target => !target.requiresNetwork);
  const ordinaryShardCount = Math.min(ordinary.length, Math.max(maxShards - (network.length > 0 ? 1 : 0), 0));
  const bins = Array.from({length: ordinaryShardCount}, () => ({postgres: false, targets: [], weight: 0}));

  if (ordinary.length > 0 && ordinaryShardCount === 0) {
    bins.push({
      postgres: true,
      targets: [...executable].sort((left, right) => left.label.localeCompare(right.label)),
      weight: executable.reduce((sum, target) => sum + target.weight, 0),
    });
  } else {
    for (const target of [...ordinary].sort(
      (left, right) => right.weight - left.weight || left.label.localeCompare(right.label),
    )) {
      const bin = bins.reduce((best, candidate) => (candidate.weight < best.weight ? candidate : best));
      bin.targets.push(target);
      bin.weight += target.weight;
    }
    if (network.length > 0) {
      bins.push({
        postgres: true,
        targets: [...network].sort((left, right) => left.label.localeCompare(right.label)),
        weight: network.reduce((sum, target) => sum + target.weight, 0),
      });
    }
  }

  return bins
    .filter(bin => bin.targets.length > 0)
    .sort((left, right) => {
      if (left.postgres !== right.postgres) return left.postgres ? 1 : -1;
      return left.targets[0].label.localeCompare(right.targets[0].label);
    })
    .map((bin, index, all) => {
      const focus = [...bin.targets].sort(
        (left, right) => right.weight - left.weight || left.label.localeCompare(right.label),
      )[0];
      return {
        id: `shard-${String(index + 1).padStart(2, '0')}`,
        name: `${index + 1}/${all.length} · ${targetName(focus.label)}`,
        postgres: bin.postgres,
        estimatedWeight: bin.weight,
        targets: bin.targets.map(target => target.label).sort(),
      };
    });
}
