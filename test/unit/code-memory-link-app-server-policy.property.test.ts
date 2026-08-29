import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {approveCodeMemoryLinkAppServerRequest} from '../../scripts/code-memory-link-app-server-policy.js';

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
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, turnId: 'turn_other'},
        scope: SCOPE,
        startedItem: item,
      }),
    ).toThrow('outside the selected thread');
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
