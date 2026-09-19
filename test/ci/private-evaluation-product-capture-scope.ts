export const privateEvaluationProductCapturePaths = [
  'src/evaluation/threadnote-5-product-capture-events.ts',
  'src/evaluation/threadnote-5-product-capture-sink.ts',
  'src/evaluation/threadnote-5-product-capture.ts',
  'test/unit/evaluation.threadnote-5-product-capture.test.ts',
] as const;

export const privateEvaluationProductCaptureFocusedTestPath =
  'test/unit/evaluation.threadnote-5-product-capture.test.ts';

const privateEvaluationProductCapturePathSet = new Set<string>(privateEvaluationProductCapturePaths);

export function isPrivateEvaluationProductCapturePath(path: string): boolean {
  return privateEvaluationProductCapturePathSet.has(path);
}

export function isPurePrivateEvaluationProductCaptureDiff(paths: Iterable<string>): boolean {
  let changed = false;
  try {
    for (const path of paths) {
      if (typeof path !== 'string' || !isPrivateEvaluationProductCapturePath(path)) return false;
      changed = true;
    }
  } catch {
    return false;
  }
  return changed;
}
