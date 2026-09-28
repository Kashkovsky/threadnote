/** Serializes canonical Git mutations across application request handlers. */
export type GitWorktreeLock = <A>(path: string, operation: () => Promise<A>) => Promise<A>;
