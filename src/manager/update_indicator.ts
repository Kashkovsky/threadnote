export function managerUpdateIndicator(state: {
  readonly autoUpdate: {
    readonly effectivePolicy: 'automatic' | 'notify';
    readonly lastSuccess?: {readonly repairRequired: boolean; readonly toVersion: string};
    readonly running?: {readonly fromVersion: string};
  };
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
}): {readonly detail: string; readonly label: string} | undefined {
  if (state.autoUpdate.running) {
    return {detail: `from v${state.autoUpdate.running.fromVersion}`, label: 'Updating in background'};
  }
  if (state.autoUpdate.lastSuccess?.repairRequired) {
    return {detail: `v${state.autoUpdate.lastSuccess.toVersion}`, label: 'Update needs attention'};
  }
  if (state.updateAvailable && state.latestVersion) {
    return {
      detail: `v${state.latestVersion}`,
      label: state.autoUpdate.effectivePolicy === 'automatic' ? 'Update queued' : 'Update available',
    };
  }
  return undefined;
}
