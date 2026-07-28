#!/usr/bin/env node
'use strict';

const SUPPORTED_NODE_RANGE = '^22.22.2 || ^24.15.0 || >=26.0.0';
const RECOMMENDED_NODE_VERSION = '24.18.0';

function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  if (!match) return false;
  const current = {major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3])};
  const atLeast = (major, minor, patch) =>
    current.major > major ||
    (current.major === major && (current.minor > minor || (current.minor === minor && current.patch >= patch)));
  if (current.major === 22) return atLeast(22, 22, 2);
  if (current.major === 24) return atLeast(24, 15, 0);
  return current.major >= 26;
}

function failureMessage(
  version,
  platform = process.platform,
  environment = process.env,
  executable = process.execPath,
) {
  const lines = [
    `Threadnote requires Node ${SUPPORTED_NODE_RANGE}; current runtime is ${String(version).replace(/^v/, '')}.`,
    'Upgrade Node, open a new terminal, and rerun the Threadnote bootstrap installer on the same stable or beta channel.',
  ];
  if (environment.NVM_DIR || environment.NVM_HOME || /(?:^|[\\/])nvm(?:[\\/]|$)/i.test(executable)) {
    lines.push(
      platform === 'win32'
        ? `nvm-windows: nvm install ${RECOMMENDED_NODE_VERSION} && nvm use ${RECOMMENDED_NODE_VERSION}`
        : 'nvm: nvm install 24 && nvm use 24',
    );
  } else if (platform === 'darwin' && /(?:homebrew|Cellar)/i.test(executable)) {
    lines.push('Homebrew: brew update && brew upgrade node (or install/upgrade node@24).');
  } else if (platform === 'win32') {
    lines.push('Windows: winget upgrade --id OpenJS.NodeJS.LTS -e (or install the current Node.js LTS MSI).');
  } else {
    lines.push('Install the current Node.js 24 LTS release with your existing package or version manager.');
  }
  lines.push('For a beta reinstall, set THREADNOTE_PACKAGE=threadnote@beta when running the bootstrap installer.');
  lines.push('Threadnote does not change the system Node installation automatically.');
  return lines.join('\n');
}

if (require.main === module && !isSupportedNodeVersion(process.versions.node)) {
  process.stderr.write(`${failureMessage(process.versions.node)}\n`);
  process.exitCode = 1;
}

module.exports = {
  failureMessage,
  isSupportedNodeVersion,
  RECOMMENDED_NODE_VERSION,
  SUPPORTED_NODE_RANGE,
};
