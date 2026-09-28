interface RemovalCount {
  readonly removed: number;
}

export interface ManagerValueRetentionReceipt {
  readonly applied: boolean;
  readonly feedback: RemovalCount;
  readonly retentionDays: number;
  readonly valueEvents: RemovalCount;
}

export interface ManagerValueDeletionReceipt {
  readonly applied: boolean;
  readonly exports: RemovalCount;
  readonly feedback: RemovalCount;
  readonly valueEvents: RemovalCount;
}

export interface ManagerValueReport {
  readonly contextBrief: {readonly attempts: number; readonly coverageGaps: number; readonly successful: number};
  readonly feedback: {
    readonly applied: number;
    readonly dismiss: number;
    readonly pin: number;
    readonly total: number;
    readonly useful: number;
    readonly wrong: number;
  };
  readonly health: {readonly opened: number; readonly resolved: number};
  readonly knowledgeDelta: {
    readonly approved: number;
    readonly deferred: number;
    readonly edited: number;
    readonly proposed: number;
    readonly rejected: number;
  };
  readonly period: {readonly from: string; readonly to: string};
  readonly setup: {
    readonly availability: 'available' | 'unavailable';
    readonly completed: number;
    readonly supportedAgentReuse: number;
    readonly timeToFirstEvidenceMilliseconds?: number;
  };
}
