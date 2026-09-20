export const CODE_GRAPH_BUILDER_HOME_CAPACITY = 2;
export const CODE_GRAPH_BUILDER_BACKGROUND_AGING_MILLISECONDS = 30_000;

export type CodeGraphBuilderAdmissionClass = 'background' | 'current-required';

export interface CodeGraphBuilderAdmissionIdentity {
  readonly checkoutId: string;
  readonly worktreeId: string;
  readonly requestKey?: string;
  readonly desiredOverlayDigest?: string;
}

export interface CodeGraphBuilderAdmissionQueue {
  readonly admissionClass: CodeGraphBuilderAdmissionClass;
  readonly enqueuedAt: string;
  readonly position: number;
  readonly size: number;
}

export interface CodeGraphBuilderAdmissionCandidate {
  readonly admissionClass: CodeGraphBuilderAdmissionClass;
  readonly checkoutId?: string;
  readonly createdAt: number;
  readonly token: string;
}

/** Old callers without a clock retain the original priority/FIFO ordering. */
export function orderCodeGraphBuilderAdmissionTickets<T extends CodeGraphBuilderAdmissionCandidate>(
  tickets: readonly T[],
  nowMilliseconds = 0,
): readonly T[] {
  const rank = (ticket: T) =>
    ticket.admissionClass === 'current-required' ||
    nowMilliseconds - ticket.createdAt >= CODE_GRAPH_BUILDER_BACKGROUND_AGING_MILLISECONDS
      ? 0
      : 1;
  return [...tickets].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.createdAt - right.createdAt ||
      (left.token < right.token ? -1 : left.token > right.token ? 1 : 0),
  );
}

/** Unknown legacy checkout identities count toward capacity, but never imply shared ownership. */
export function selectCodeGraphBuilderAdmissionTickets<T extends CodeGraphBuilderAdmissionCandidate>(
  tickets: readonly T[],
  activeCheckoutIds: readonly (string | undefined)[],
  nowMilliseconds: number,
): readonly T[] {
  return orderCodeGraphBuilderAdmissionQueue(tickets, activeCheckoutIds, nowMilliseconds).slice(
    0,
    Math.max(0, CODE_GRAPH_BUILDER_HOME_CAPACITY - activeCheckoutIds.length),
  );
}

/** Project an advisory total order from current occupancy; recompute it whenever a slot changes. */
export function orderCodeGraphBuilderAdmissionQueue<T extends CodeGraphBuilderAdmissionCandidate>(
  tickets: readonly T[],
  activeCheckoutIds: readonly (string | undefined)[],
  nowMilliseconds: number,
): readonly T[] {
  const remaining = [...orderCodeGraphBuilderAdmissionTickets(tickets, nowMilliseconds)];
  const occupied = new Set(activeCheckoutIds.filter(id => id !== undefined));
  const selected: T[] = [];
  while (remaining.length > 0) {
    const diverse = remaining.findIndex(ticket => ticket.checkoutId === undefined || !occupied.has(ticket.checkoutId));
    const [next] = remaining.splice(diverse < 0 ? 0 : diverse, 1);
    selected.push(next);
    if (next.checkoutId !== undefined) occupied.add(next.checkoutId);
  }
  return selected;
}
