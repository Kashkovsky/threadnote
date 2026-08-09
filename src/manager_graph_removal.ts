import type {ManagerDialogOptions} from './manager_dialog.js';

export type ManagerGraphViewRemovalState = 'already-removed' | 'not-found' | 'ready' | 'removed' | 'stale-target';

export interface ManagerGraphViewRemovalResponse {
  readonly approvalDigest: string;
  readonly output: string;
  readonly result: {
    readonly state: ManagerGraphViewRemovalState;
  };
}

/** Only a current dry-run target can become the final destructive approval surface. */
export function graphViewRemovalApprovalDialog(
  preview: ManagerGraphViewRemovalResponse,
): ManagerDialogOptions | undefined {
  if (preview.result.state !== 'ready') return undefined;
  return {
    confirmLabel: 'Remove view',
    detail: preview.output,
    message:
      'Review this exact dry-run preview. Threadnote will reject the approval if the target changes before removal.',
    title: 'Remove this indexed view?',
    tone: 'danger',
  };
}
