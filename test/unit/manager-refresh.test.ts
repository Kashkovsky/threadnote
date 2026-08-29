import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {settleManagerRefreshTasks} from '../../src/manager/refresh.js';

describe('Manager refresh isolation', () => {
  it('keeps successful refreshes when one endpoint fails', async () => {
    const completed: string[] = [];
    const failures = await settleManagerRefreshTasks([
      {label: 'Runtime', run: async () => void completed.push('runtime')},
      {
        label: 'Memory library',
        run: async () => {
          throw new Error('tree unavailable');
        },
      },
      {label: 'Shares', run: async () => void completed.push('shares')},
    ]);

    expect(completed).toEqual(['runtime', 'shares']);
    expect(failures).toEqual(['Memory library: tree unavailable']);
  });

  it('attempts every refresh once and reports failures in task order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), {maxLength: 12}), async shouldFail => {
        const calls = shouldFail.map(() => 0);
        const failures = await settleManagerRefreshTasks(
          shouldFail.map((fail, index) => ({
            label: `task-${index}`,
            run: async () => {
              calls[index] += 1;
              if (fail) throw new Error(`failed-${index}`);
            },
          })),
        );

        expect(calls).toEqual(shouldFail.map(() => 1));
        expect(failures).toEqual(shouldFail.flatMap((fail, index) => (fail ? [`task-${index}: failed-${index}`] : [])));
      }),
      {numRuns: 64},
    );
  });
});
