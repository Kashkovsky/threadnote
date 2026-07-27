import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];
const forbiddenFiles = [
  'config/ov.conf.template.json',
  'config/ovcli.conf.template.json',
  'scripts/local-ai-server.py',
  'scripts/install-e2e-openviking.mjs',
];
for (const file of forbiddenFiles) {
  if (exists(join(root, file))) failures.push(`legacy file remains: ${file}`);
}

const allowedLegacySources = new Set([
  'src/effect/cli.ts',
  'src/lifecycle.ts',
  'src/migration/home.ts',
  'src/storage/layout.ts',
]);
for (const file of files(join(root, 'src'))) {
  const path = relative(root, file).split('\\').join('/');
  const content = readFileSync(file, 'utf8');
  if (/\b(?:openviking|python|pipx)\b/i.test(content) && !allowedLegacySources.has(path)) {
    failures.push(`legacy runtime token outside migration boundary: ${path}`);
  }
  if (/from ['"]node-llama-cpp['"]/.test(content) && path !== 'src/effect/ai/node-llama-cpp.ts') {
    failures.push(`raw node-llama-cpp import outside adapter: ${path}`);
  }
  if (/from ['"]node:child_process['"]/.test(content)) {
    failures.push(`raw child-process import in production source: ${path}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (packageJson.dependencies?.['node-llama-cpp'] !== '3.19.1') {
  failures.push('node-llama-cpp must be an exact runtime dependency at 3.19.1');
}
if (packageJson.config?.nodeLlamaCppPostinstall !== 'skip') {
  failures.push('node-llama-cpp postinstall must default to skip');
}
if (/\b(?:python|pipx|openviking)\b/i.test(JSON.stringify(packageJson.scripts ?? {}))) {
  failures.push('package scripts reference a legacy runtime');
}
for (const installer of ['scripts/install.sh', 'scripts/install.ps1']) {
  if (!/NODE_LLAMA_CPP_POSTINSTALL[^\n\r]*skip/i.test(readFileSync(join(root, installer), 'utf8'))) {
    failures.push(`installer does not suppress node-llama-cpp postinstall downloads: ${installer}`);
  }
}

const pack = JSON.parse(
  execFileSync('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  }),
);
for (const entry of pack[0]?.files ?? []) {
  const path = String(entry.path);
  if (path.endsWith('.py') || /(?:^|\/)(?:ov|ovcli)\.conf(?:\.|$)/i.test(path) || /openviking|launchd/i.test(path)) {
    failures.push(`legacy artifact would ship: ${path}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map(failure => `- ${failure}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Self-contained source and package checks passed.\n');
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function files(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}
