/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed adapter validates app-server actions before execution. */
import {createHash} from 'node:crypto';
import {isAbsolute, resolve, sep} from 'node:path';
import {codeMemoryLinkAppServerOpaqueIdDigest} from '../src/evaluation/code-memory-link-agent-protocol.js';

export interface CodeMemoryLinkAppServerApprovalReceiptV1 {
  readonly itemIdDigest: string;
  readonly itemType: 'commandExecution' | 'fileChange';
  readonly requestDigest: string;
}

interface ApprovalScope {
  readonly repositoryRoot: string;
  readonly threadId: string;
  readonly turnId: string;
}

const FORBIDDEN_PATH_SEGMENTS = new Set(['.codex', '.git']);
const SIMPLE_READ_EXECUTABLES = new Set(['cat', 'file', 'head', 'nl', 'stat', 'tail', 'wc']);
const SIMPLE_FLAGS = new Map<string, ReadonlySet<string>>([
  ['cat', new Set(['-b', '-n', '-s', '--'])],
  ['file', new Set(['-b', '--'])],
  ['head', new Set(['-n', '--'])],
  ['nl', new Set(['-b', '-n', '--'])],
  ['stat', new Set(['-f', '--'])],
  ['tail', new Set(['-n', '--'])],
  ['wc', new Set(['-c', '-l', '-w', '--'])],
]);

export function approveCodeMemoryLinkAppServerRequest(input: {
  readonly method: string;
  readonly params: unknown;
  readonly scope: ApprovalScope;
  readonly startedItem: unknown;
}): CodeMemoryLinkAppServerApprovalReceiptV1 {
  if (input.method === 'item/commandExecution/requestApproval') {
    return approveCommand(input.params, input.startedItem, input.scope);
  }
  if (input.method === 'item/fileChange/requestApproval') {
    return approveFileChange(input.params, input.startedItem, input.scope);
  }
  throw new Error(`Unsupported Code Memory Link app-server approval request ${input.method}.`);
}

export function assertCodeMemoryLinkPublicAction(
  itemInput: unknown,
  repositoryRoot: string,
): 'commandExecution' | 'fileChange' | null {
  const item = object(itemInput, 'app-server action item');
  if (item.type === 'commandExecution') {
    assertReadCommand(item, repositoryRoot);
    return 'commandExecution';
  }
  if (item.type === 'fileChange') {
    assertFileChanges(item, repositoryRoot);
    return 'fileChange';
  }
  return null;
}

function approveCommand(
  paramsInput: unknown,
  startedItemInput: unknown,
  scope: ApprovalScope,
): CodeMemoryLinkAppServerApprovalReceiptV1 {
  const params = object(paramsInput, 'command approval params');
  exactKeys(
    params,
    [
      'approvalId',
      'availableDecisions',
      'command',
      'commandActions',
      'cwd',
      'environmentId',
      'itemId',
      'networkApprovalContext',
      'proposedExecpolicyAmendment',
      'proposedNetworkPolicyAmendments',
      'reason',
      'startedAtMs',
      'threadId',
      'turnId',
    ],
    'command approval params',
    true,
  );
  assertApprovalScope(params, scope);
  if (
    params.approvalId != null ||
    (params.environmentId != null && params.environmentId !== 'local') ||
    params.networkApprovalContext != null ||
    params.proposedNetworkPolicyAmendments != null
  ) {
    throw new Error('Code Memory Link rejects compound, remote, and network command approvals.');
  }
  assertTemporaryCommandApproval(params);
  const item = object(startedItemInput, 'started command item');
  if (item.type !== 'commandExecution' || item.id !== params.itemId) {
    throw new Error('Command approval does not match its started action item.');
  }
  for (const field of ['command', 'commandActions', 'cwd'] as const) {
    if (JSON.stringify(params[field] ?? null) !== JSON.stringify(item[field] ?? null)) {
      throw new Error(`Command approval ${field} differs from its started action item.`);
    }
  }
  assertReadCommand(item, scope.repositoryRoot);
  return receipt('commandExecution', String(params.itemId), params);
}

function assertTemporaryCommandApproval(params: Record<string, unknown>): void {
  if (params.proposedExecpolicyAmendment != null) {
    if (
      !Array.isArray(params.proposedExecpolicyAmendment) ||
      params.proposedExecpolicyAmendment.length === 0 ||
      params.proposedExecpolicyAmendment.length > 32 ||
      params.proposedExecpolicyAmendment.some(
        token => typeof token !== 'string' || token.length === 0 || token.length > 256 || token.includes('\0'),
      )
    ) {
      throw new Error('Code Memory Link command approval proposes an invalid execpolicy amendment.');
    }
  }
  if (params.availableDecisions == null) return;
  if (
    !Array.isArray(params.availableDecisions) ||
    !params.availableDecisions.includes('accept') ||
    !params.availableDecisions.includes('cancel') ||
    new TextEncoder().encode(JSON.stringify(params.availableDecisions)).byteLength > 4_096
  ) {
    throw new Error('Code Memory Link command approval lacks bounded one-time decisions.');
  }
}

function approveFileChange(
  paramsInput: unknown,
  startedItemInput: unknown,
  scope: ApprovalScope,
): CodeMemoryLinkAppServerApprovalReceiptV1 {
  const params = object(paramsInput, 'file-change approval params');
  exactKeys(
    params,
    ['grantRoot', 'itemId', 'reason', 'startedAtMs', 'threadId', 'turnId'],
    'file-change approval params',
    true,
  );
  assertApprovalScope(params, scope);
  if (params.grantRoot != null) throw new Error('Code Memory Link rejects persistent file-change grants.');
  const item = object(startedItemInput, 'started file-change item');
  if (item.type !== 'fileChange' || item.id !== params.itemId) {
    throw new Error('File-change approval does not match its started action item.');
  }
  assertFileChanges(item, scope.repositoryRoot);
  return receipt('fileChange', String(params.itemId), params);
}

function assertApprovalScope(params: Record<string, unknown>, scope: ApprovalScope): void {
  if (
    params.threadId !== scope.threadId ||
    params.turnId !== scope.turnId ||
    typeof params.itemId !== 'string' ||
    params.itemId.length === 0 ||
    params.itemId.length > 256 ||
    !Number.isSafeInteger(params.startedAtMs)
  ) {
    throw new Error('App-server approval is outside the selected thread, turn, or item scope.');
  }
}

function assertReadCommand(item: Record<string, unknown>, repositoryRoot: string): void {
  const cwd = containedPath(text(item.cwd, 'command cwd'), repositoryRoot);
  const commands = reviewableCommands(item, repositoryRoot, cwd);
  for (const command of commands) assertSingleReadCommand(command, repositoryRoot, cwd);
  if (!text(item.command, 'command').startsWith('/bin/zsh -lc ')) {
    if (!Array.isArray(item.commandActions) || item.commandActions.length === 0) {
      throw new Error('Code Memory Link command lacks a reviewable read-only action projection.');
    }
    assertReadOnlyActionProjection(item.commandActions as readonly unknown[], repositoryRoot, cwd);
  }
}

function assertSingleReadCommand(command: string, repositoryRoot: string, cwd: string): void {
  const tokens = tokenize(command);
  const executable = tokens[0];
  if (!executable || executable.includes('/') || executable.includes('\\')) {
    throw new Error('Code Memory Link commands require one bare reviewed executable name.');
  }
  if (executable === 'pwd') {
    if (tokens.length !== 1) throw new Error('pwd does not accept arguments in the evaluation policy.');
  } else if (executable === 'ls') assertLs(tokens.slice(1), repositoryRoot, cwd);
  else if (executable === 'rg') assertRipgrep(tokens.slice(1), repositoryRoot, cwd);
  else if (executable === 'sed') assertSed(tokens.slice(1), repositoryRoot, cwd);
  else if (SIMPLE_READ_EXECUTABLES.has(executable)) {
    assertSimpleRead(executable, tokens.slice(1), repositoryRoot, cwd);
  } else {
    throw new Error('Code Memory Link command executable is outside the reviewed read-only allowlist.');
  }
}

function reviewableCommands(item: Record<string, unknown>, repositoryRoot: string, cwd: string): readonly string[] {
  const command = text(item.command, 'command');
  if (command.startsWith('/bin/zsh -lc ')) {
    if (
      !Array.isArray(item.commandActions) ||
      (item.source !== 'agent' && item.source !== 'unifiedExecStartup') ||
      item.commandActions.length !== 1
    ) {
      throw new Error('Code Memory Link shell command lacks one reviewed local action projection.');
    }
    const action = object(item.commandActions[0], 'command action');
    const projected = text(action.command, 'code-mode command projection');
    const wrapped = decodeShellWord(command.slice('/bin/zsh -lc '.length));
    if (wrapped !== projected) throw new Error('Code Memory Link shell wrapper differs from its action projection.');
    if (action.type === 'unknown') {
      exactKeys(action, ['command', 'type'], 'code-mode compound command action', false);
      return splitReadCommandChain(projected);
    }
    assertReadOnlyActionProjection([action], repositoryRoot, cwd);
    return [projected];
  }
  return [command];
}

function assertReadOnlyActionProjection(commandActions: readonly unknown[], repositoryRoot: string, cwd: string): void {
  for (const actionInput of commandActions) {
    const action = object(actionInput, 'command action');
    if (!['read', 'listFiles', 'search'].includes(String(action.type))) {
      throw new Error('Code Memory Link command action is not read-only.');
    }
    if (typeof action.path === 'string' && action.path.length > 0) containedPath(action.path, repositoryRoot, cwd);
  }
}

function splitReadCommandChain(command: string): readonly string[] {
  if (command.length > 16_384 || /[\0\r\n]/u.test(command)) {
    throw new Error('Command chain is not bounded single-line text.');
  }
  const commands: string[] = [];
  let start = 0;
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = null;
      else if (character === '$' || character === '`' || character === '\\') {
        throw new Error('Command chain contains expansion inside double quotes.');
      }
      continue;
    }
    if (character === "'") quote = 'single';
    else if (character === '"') quote = 'double';
    else if (character === '&') {
      if (command[index + 1] !== '&') throw new Error('Command chain contains unsupported shell control.');
      commands.push(nonemptyCommand(command.slice(start, index)));
      start = index + 2;
      index += 1;
    } else if (';|<>`$(){}\\'.includes(character)) {
      throw new Error('Command chain contains unsupported shell control or expansion.');
    }
  }
  if (quote !== null) throw new Error('Command chain contains an unterminated quote.');
  commands.push(nonemptyCommand(command.slice(start)));
  return commands;
}

function nonemptyCommand(value: string): string {
  const command = value.trim();
  if (!command) throw new Error('Command chain contains an empty command.');
  return command;
}

function decodeShellWord(value: string): string {
  if (!value || value.length > 16_384 || /[\0\r\n]/u.test(value)) {
    throw new Error('Code Memory Link shell wrapper is invalid.');
  }
  let decoded = '';
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote === 'single') {
      if (character === "'") quote = null;
      else decoded += character;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = null;
      else if (character === '\\') {
        const escaped = value[++index];
        if (escaped !== '"' && escaped !== '\\') {
          throw new Error('Code Memory Link shell wrapper contains unsupported escaping.');
        }
        decoded += escaped;
      } else {
        if (character === '$' || character === '`') {
          throw new Error('Code Memory Link shell wrapper contains expansion.');
        }
        decoded += character;
      }
      continue;
    }
    if (character === "'") quote = 'single';
    else if (character === '"') quote = 'double';
    else if (/\s/u.test(character) || ';&|<>`$(){}\\*?[]'.includes(character)) {
      throw new Error('Code Memory Link shell wrapper must contain exactly one literal argument.');
    } else decoded += character;
  }
  if (quote !== null) throw new Error('Code Memory Link shell wrapper contains an unterminated quote.');
  return decoded;
}

function assertSimpleRead(executable: string, args: readonly string[], root: string, cwd: string): void {
  const flags = SIMPLE_FLAGS.get(executable)!;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (flags.has(value)) {
      if (['head', 'tail'].includes(executable) && value === '-n') positiveCount(args[++index], `${executable} -n`);
      else if (executable === 'stat' && value === '-f') boundedLiteral(args[++index], 'stat format');
      else if (executable === 'nl' && (value === '-b' || value === '-n')) boundedLiteral(args[++index], `nl ${value}`);
      continue;
    }
    if (/^-[0-9]+$/u.test(value) && (executable === 'head' || executable === 'tail')) continue;
    if (value.startsWith('-')) throw new Error(`${executable} option is outside the reviewed grammar.`);
    paths.push(value);
  }
  if (paths.length === 0) throw new Error(`${executable} requires an explicit repository file.`);
  for (const path of paths) containedPath(path, root, cwd);
}

function assertLs(args: readonly string[], root: string, cwd: string): void {
  const paths: string[] = [];
  for (const value of args) {
    if (value === '--' || /^-[1aFlhR]+$/u.test(value)) continue;
    if (value.startsWith('-')) throw new Error('ls option is outside the reviewed grammar.');
    paths.push(value);
  }
  for (const path of paths.length === 0 ? ['.'] : paths) containedPath(path, root, cwd);
}

function assertSed(args: readonly string[], root: string, cwd: string): void {
  if (args.length < 3 || args[0] !== '-n' || !/^[0-9]+(?:,[0-9]+)?p$/u.test(args[1]!)) {
    throw new Error('sed is limited to one numeric print range.');
  }
  for (const path of args.slice(2)) {
    if (path.startsWith('-')) throw new Error('sed path is invalid.');
    containedPath(path, root, cwd);
  }
}

function assertRipgrep(args: readonly string[], root: string, cwd: string): void {
  let filesMode = false;
  const positionals: string[] = [];
  const valueOptions = new Set([
    '-A',
    '-B',
    '-C',
    '-g',
    '--after-context',
    '--before-context',
    '--context',
    '--glob',
    '--max-count',
    '--type',
  ]);
  const flags = new Set([
    '-F',
    '-S',
    '-i',
    '-l',
    '-n',
    '--files',
    '--files-with-matches',
    '--fixed-strings',
    '--hidden',
    '--ignore-case',
    '--line-number',
    '--no-heading',
    '--smart-case',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (flags.has(value)) {
      filesMode ||= value === '--files';
      continue;
    }
    if (valueOptions.has(value)) {
      const optionValue = boundedLiteral(args[++index], `rg ${value}`);
      if (value === '-g' || value === '--glob') safeGlob(optionValue);
      else if (value !== '--type') positiveCount(optionValue, `rg ${value}`);
      continue;
    }
    if (value.startsWith('-')) throw new Error('rg option is outside the reviewed grammar.');
    positionals.push(value);
  }
  const paths = filesMode ? positionals : positionals.slice(1);
  if (!filesMode && positionals.length === 0) throw new Error('rg requires an explicit search pattern.');
  for (const path of paths.length === 0 ? ['.'] : paths) containedPath(path, root, cwd);
}

function assertFileChanges(item: Record<string, unknown>, repositoryRoot: string): void {
  if (!Array.isArray(item.changes) || item.changes.length === 0) {
    throw new Error('Code Memory Link file change has no paths.');
  }
  for (const changeInput of item.changes) {
    const change = object(changeInput, 'file change');
    containedPath(text(change.path, 'file change path'), repositoryRoot);
    if (typeof change.diff !== 'string' || new TextEncoder().encode(change.diff).byteLength > 2 * 1_024 * 1_024) {
      throw new Error('Code Memory Link file-change diff is missing or oversized.');
    }
    const kind = object(change.kind, 'file change kind');
    if (kind.update !== undefined) {
      const update = object(kind.update, 'file update');
      if (update.movePath != null) containedPath(text(update.movePath, 'file move path'), repositoryRoot);
    }
  }
}

function tokenize(command: string): readonly string[] {
  if (command.length > 16_384 || /[\0\r\n]/u.test(command)) throw new Error('Command is not bounded single-line text.');
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let active = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === 'single') {
      if (character === "'") quote = null;
      else token += character;
      active = true;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = null;
      else {
        if (character === '$' || character === '`' || character === '\\') {
          throw new Error('Command contains expansion inside double quotes.');
        }
        token += character;
      }
      active = true;
      continue;
    }
    if (character === "'") {
      quote = 'single';
      active = true;
    } else if (character === '"') {
      quote = 'double';
      active = true;
    } else if (/\s/u.test(character)) {
      if (active) {
        tokens.push(token);
        token = '';
        active = false;
      }
    } else {
      if (';&|<>`$(){}\\*?[]'.includes(character)) {
        throw new Error('Command contains shell control, expansion, or an unquoted glob.');
      }
      token += character;
      active = true;
    }
  }
  if (quote !== null) throw new Error('Command contains an unterminated quote.');
  if (active) tokens.push(token);
  if (tokens.length === 0) throw new Error('Command is empty.');
  return tokens;
}

function containedPath(value: string, rootInput: string, cwdInput = rootInput): string {
  if (value.includes('\0') || value.includes('\\')) throw new Error('Repository path is invalid.');
  const segments = value.split('/');
  if (segments.some(segment => segment === '..' || FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    throw new Error('Repository path contains a forbidden parent or control segment.');
  }
  const root = resolve(rootInput);
  const cwd = resolve(cwdInput);
  const candidate = resolve(isAbsolute(value) ? value : resolve(cwd, value));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error('App-server action referenced a path outside the public task repository.');
  }
  return candidate;
}

function safeGlob(value: string): void {
  if (!value || value.length > 256 || value.includes('..') || /[{}\\]/u.test(value)) {
    throw new Error('rg glob is outside the reviewed grammar.');
  }
}

function positiveCount(value: string | undefined, label: string): void {
  if (!value || !/^[1-9][0-9]{0,5}$/u.test(value)) throw new Error(`${label} requires a bounded positive integer.`);
}

function boundedLiteral(value: string | undefined, label: string): string {
  if (!value || value.length > 256 || value.includes('\0')) throw new Error(`${label} requires a bounded value.`);
  return value;
}

function receipt(
  itemType: CodeMemoryLinkAppServerApprovalReceiptV1['itemType'],
  itemId: string,
  params: Record<string, unknown>,
): CodeMemoryLinkAppServerApprovalReceiptV1 {
  return {
    itemIdDigest: codeMemoryLinkAppServerOpaqueIdDigest('item', itemId),
    itemType,
    requestDigest: digest('approval', JSON.stringify(params)),
  };
}

function digest(domain: string, value: string): string {
  return createHash('sha256').update(`threadnote-code-memory-link-${domain}-v1\0${value}`).digest('hex');
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, optional: boolean): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) throw new Error(`${label} has unsupported fields.`);
  if (!optional && allowed.some(key => !(key in value))) throw new Error(`${label} has missing fields.`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || value.includes('\0')) {
    throw new Error(`${label} must be bounded nonempty text.`);
  }
  return value;
}
