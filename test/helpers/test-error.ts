/** Typed failure for deliberate test-boundary failures and injected faults. */
export class TestError extends Error {
  readonly _tag = 'TestError' as const;
}
