import {describe, expect, it} from 'vitest';
import {
  graphViewRemovalApprovalDialog,
  type ManagerGraphViewRemovalResponse,
  type ManagerGraphViewRemovalState,
} from '../../src/manager_graph_removal.js';

describe('Manager graph view removal', () => {
  it('offers destructive approval only for the exact ready preview', () => {
    const preview = response('ready');

    expect(graphViewRemovalApprovalDialog(preview)).toEqual({
      confirmLabel: 'Remove view',
      detail: preview.output,
      message:
        'Review this exact dry-run preview. Threadnote will reject the approval if the target changes before removal.',
      title: 'Remove this indexed view?',
      tone: 'danger',
    });
    for (const state of ['already-removed', 'not-found', 'removed', 'stale-target'] as const) {
      expect(graphViewRemovalApprovalDialog(response(state))).toBeUndefined();
    }
  });
});

function response(state: ManagerGraphViewRemovalState): ManagerGraphViewRemovalResponse {
  return {
    approvalDigest: `sha256:${'a'.repeat(64)}`,
    output: 'Would remove exact view and preserve shared snapshot data.',
    result: {state},
  };
}
