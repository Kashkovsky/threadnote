/** Release owned processes before publication, and retain the runtime until publication finishes. */
export async function withStage3Cleanup<A>(
  work: () => Promise<A>,
  cleanup: () => Promise<void>,
  publish: (value: A) => Promise<void>,
  dispose: () => Promise<void>,
): Promise<A> {
  try {
    let value: A;
    try {
      value = await work();
    } finally {
      await cleanup();
    }
    await publish(value);
    return value;
  } finally {
    await dispose();
  }
}
