import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {approveCodeMemoryLinkAppServerRequest} from '../../../../scripts/code-memory-link-app-server-policy.js';

const ROOT = '/sealed/public-repository';
const SCOPE = {repositoryRoot: ROOT, threadId: 'thr_gate', turnId: 'turn_gate'};

describe('Code Memory Link pre-execution app-server policy', () => {
  it('accepts only a scope-matched bounded repository read', () => {
    const {item, params} = commandApproval("sed -n '1,40p' src/service.ts", 'src/service.ts');
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params,
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, additionalPermissions: null},
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, additionalPermissions: {fileSystem: null, network: {enabled: true}}},
        scope: SCOPE,
        startedItem: item,
      }),
    ).toThrow('additional permissions');
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, proposedExecpolicyAmendment: Array.from({length: 64}, () => 'pwd')},
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, turnId: 'turn_other'},
        scope: SCOPE,
        startedItem: item,
      }),
    ).toThrow('outside the selected thread');

    const od = commandApproval('od -An -tx1 -N 3 src/service.ts', 'src/service.ts');
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: od.params,
        scope: SCOPE,
        startedItem: od.item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    for (const command of [
      "find . -maxdepth 3 -type f -name '*.ts' -print",
      'git status --short',
      'git rev-parse --show-toplevel',
      'git ls-files --cached -- src/service.ts',
      'git diff',
      'git diff --check',
      'git diff -- src/service.ts',
      'git diff --cached --no-ext-diff --no-renames --color=never -- src/service.ts',
    ]) {
      const git = commandApproval(command, 'src/service.ts');
      expect(
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: git.params,
          scope: SCOPE,
          startedItem: git.item,
        }),
      ).toMatchObject({itemType: 'commandExecution'});
    }
  });

  it('accepts the pinned code-mode shell wrapper only when every projected command is a bounded read', () => {
    const projected = "pwd && sed -n '1,40p' src/service.ts";
    const command = `/bin/zsh -lc ${shellWord(projected)}`;
    const commandActions = [{command: projected, type: 'unknown'}];
    const item = {
      command,
      commandActions,
      cwd: ROOT,
      id: 'item_code_mode_command',
      source: 'agent',
      status: 'inProgress',
      type: 'commandExecution',
    };
    const params = {
      approvalId: null,
      availableDecisions: [
        'accept',
        {acceptWithExecpolicyAmendment: {execpolicy_amendment: ['pwd']}},
        'decline',
        'cancel',
      ],
      command,
      commandActions,
      cwd: ROOT,
      environmentId: 'local',
      itemId: item.id,
      networkApprovalContext: null,
      proposedExecpolicyAmendment: ['pwd'],
      proposedNetworkPolicyAmendments: null,
      reason: null,
      startedAtMs: 1,
      threadId: SCOPE.threadId,
      turnId: SCOPE.turnId,
    };

    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params,
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    const escapedRegexProjected = 'rg -n "@overload|def application\\\\(" src tests | head -80';
    const escapedRegexCommand = `/bin/zsh -c "${escapedRegexProjected
      .replaceAll('\\\\', '\\\\\\\\')
      .replaceAll('"', '\\"')}"`;
    const escapedRegexActions = [
      {
        command: 'rg -n "@overload|def application\\\\(" src tests',
        path: `${ROOT}/src`,
        query: '@overload|def application\\(',
        type: 'search',
      },
    ];
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, command: escapedRegexCommand, commandActions: escapedRegexActions},
        scope: SCOPE,
        startedItem: {...item, command: escapedRegexCommand, commandActions: escapedRegexActions},
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    for (const flag of ['-c', '-lc']) {
      const completedDisplayCommand = `${shellWord('/bin/zsh')} ${flag} ${shellWord(projected)}`;
      expect(
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: {...params, command: completedDisplayCommand},
          scope: SCOPE,
          startedItem: {...item, command: completedDisplayCommand, source: 'unifiedExecStartup'},
        }),
      ).toMatchObject({itemType: 'commandExecution'});
    }

    const sequence = "pwd; sed -n '1,40p' src/service.ts";
    const sequenceCommand = `/bin/zsh -c ${shellWord(sequence)}`;
    const sequenceActions = [
      {command: 'pwd', type: 'read'},
      {command: "sed -n '1,40p' src/service.ts", path: `${ROOT}/src/service.ts`, type: 'read'},
    ];
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, command: sequenceCommand, commandActions: sequenceActions},
        scope: SCOPE,
        startedItem: {...item, command: sequenceCommand, commandActions: sequenceActions},
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    const pipeline = 'rg -n service src | head -n 5';
    const pipelineCommand = `/bin/zsh -c ${shellWord(pipeline)}`;
    const pipelineActions = [
      {command: 'rg -n service src', path: `${ROOT}/src`, type: 'search'},
      {command: 'head -n 5', type: 'read'},
    ];
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, command: pipelineCommand, commandActions: pipelineActions},
        scope: SCOPE,
        startedItem: {...item, command: pipelineCommand, commandActions: pipelineActions},
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    for (const unsafe of [
      'pwd || cat src/service.ts',
      'cat src/service.ts > result.json',
      'cat $(pwd)/src/service.ts',
      'rg -n "$HOME" src/service.ts',
      'sed -i 1d src/service.ts',
    ]) {
      const unsafeCommand = `/bin/zsh -lc ${shellWord(unsafe)}`;
      const unsafeActions = [{command: unsafe, type: 'unknown'}];
      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: {...params, command: unsafeCommand, commandActions: unsafeActions},
          scope: SCOPE,
          startedItem: {...item, command: unsafeCommand, commandActions: unsafeActions},
        }),
      ).toThrow();
    }
  });

  it('rejects shell-control, expansion, unquoted glob, and mutating sed syntax before execution', () => {
    fc.assert(
      fc.property(fc.constantFrom(';', '|', '&', '$', '`', '>', '<', '*', '?', '[x]'), operator => {
        const command = `cat src/service.ts ${operator} private`;
        const {item, params} = commandApproval(command, 'src/service.ts');
        expect(() =>
          approveCodeMemoryLinkAppServerRequest({
            method: 'item/commandExecution/requestApproval',
            params,
            scope: SCOPE,
            startedItem: item,
          }),
        ).toThrow();
      }),
      {numRuns: 50},
    );
    for (const command of ["sed -n '1,20w /tmp/leak' src/service.ts", "sed -n '1e id' src/service.ts"]) {
      const {item, params} = commandApproval(command, 'src/service.ts');
      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params,
          scope: SCOPE,
          startedItem: item,
        }),
      ).toThrow('numeric print range');
    }
  });

  it('rejects Git mutation, configuration overrides, and paths outside the public repository', () => {
    for (const command of [
      'git add src/service.ts',
      'git config core.pager cat',
      'git -c core.pager=cat status --short',
      'git diff HEAD -- src/service.ts',
      'git diff --ext-diff -- src/service.ts',
      'git diff -- ../private',
      'git ls-files --exclude-from=/tmp/patterns',
      'git ls-files -- ../private',
    ]) {
      const git = commandApproval(command, 'src/service.ts');
      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: git.params,
          scope: SCOPE,
          startedItem: git.item,
        }),
      ).toThrow();
    }
  });

  it('rejects find execution, mutation, writes, and paths outside the public repository', () => {
    for (const command of [
      'find . -exec cat src/service.ts',
      'find . -delete',
      'find . -fprint result.txt',
      'find ../private -type f',
      'find . -type s',
    ]) {
      const find = commandApproval(command, 'src/service.ts');
      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: find.params,
          scope: SCOPE,
          startedItem: find.item,
        }),
      ).toThrow();
    }
  });

  it('rejects persistent grants and paths outside the public repository', () => {
    const item = {
      changes: [{diff: '+safe', kind: {update: {movePath: null}}, path: `${ROOT}/result.json`}],
      id: 'item_change',
      status: 'inProgress',
      type: 'fileChange',
    };
    const params = {
      grantRoot: ROOT,
      itemId: item.id,
      reason: null,
      startedAtMs: 1,
      threadId: SCOPE.threadId,
      turnId: SCOPE.turnId,
    };
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/fileChange/requestApproval',
        params,
        scope: SCOPE,
        startedItem: item,
      }),
    ).toThrow('persistent file-change grants');
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/fileChange/requestApproval',
        params: {...params, grantRoot: null},
        scope: SCOPE,
        startedItem: {...item, changes: [{...item.changes[0], path: '/private/rubric.json'}]},
      }),
    ).toThrow('outside the public task repository');
  });

  it('accepts the current app-server file-change shape only for contained bounded changes', () => {
    const item = {
      changes: [
        {
          diff: '@@ -1 +1 @@\n-old\n+new\n',
          kind: {move_path: null, type: 'update'},
          path: `${ROOT}/src/service.ts`,
        },
      ],
      id: 'item_current_change',
      status: 'inProgress',
      type: 'fileChange',
    };
    const params = {
      grantRoot: null,
      itemId: item.id,
      reason: null,
      startedAtMs: 1,
      threadId: SCOPE.threadId,
      turnId: SCOPE.turnId,
    };

    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/fileChange/requestApproval',
        params,
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'fileChange'});
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/fileChange/requestApproval',
        params,
        scope: SCOPE,
        startedItem: {
          ...item,
          changes: [{...item.changes[0], kind: {move_path: '/private/escape', type: 'update'}}],
        },
      }),
    ).toThrow('outside the public task repository');
  });
});

function commandApproval(command: string, path: string) {
  const commandActions = [{command, name: path.split('/').at(-1), path: `${ROOT}/${path}`, type: 'read'}];
  const item = {
    command,
    commandActions,
    cwd: ROOT,
    id: 'item_command',
    status: 'inProgress',
    type: 'commandExecution',
  };
  return {
    item,
    params: {
      approvalId: null,
      command,
      commandActions,
      cwd: ROOT,
      environmentId: null,
      itemId: item.id,
      networkApprovalContext: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      reason: null,
      startedAtMs: 1,
      threadId: SCOPE.threadId,
      turnId: SCOPE.turnId,
    },
  };
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
