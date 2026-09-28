/* oxlint-disable effecttsgo/node-builtin-import -- CI artifact and GitHub output boundary. */
import {appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {planBazelShards} from './bazel-shards.mjs';

const root = resolve(import.meta.dir, '../..');
const output = resolve(root, process.argv[2] ?? '.context/bazel-selection');
const selection = JSON.parse(readFileSync(resolve(output, 'selection.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(resolve(root, 'tools/bazel/targets.json'), 'utf8'));
const known = new Set(inventory.targets.map(target => target.label));
if (!Array.isArray(selection.targets) || selection.targets.some(label => !known.has(label)))
  throw new Error('Invalid modeled target selection');

const shards = planBazelShards({inventory: inventory.targets, selected: selection.targets});
const shardDirectory = resolve(output, 'shards');
rmSync(shardDirectory, {recursive: true, force: true});
mkdirSync(shardDirectory, {recursive: true});
for (const shard of shards) {
  writeFileSync(
    resolve(shardDirectory, `${shard.id}.json`),
    JSON.stringify({...selection, shard, targets: shard.targets}, null, 2) + '\n',
  );
}
writeFileSync(resolve(output, 'shards.json'), JSON.stringify({shards}, null, 2) + '\n');

const matrix = {include: shards.map(({id, name, postgres}) => ({id, name, postgres}))};
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `execute_bazel=${shards.length > 0}\n`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `executable_targets=${shards.reduce((count, shard) => count + shard.targets.length, 0)}\n`,
  );
}
process.stdout.write(
  `Planned ${shards.reduce((count, shard) => count + shard.targets.length, 0)} executable targets across ${shards.length} shard(s).\n`,
);
