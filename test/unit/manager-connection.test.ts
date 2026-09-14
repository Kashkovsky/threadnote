import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  initialManagerAvailability,
  managerActionsAreAvailable,
  managerAvailabilityTransition,
  managerSelectionIsReadable,
  reconcileManagerDraft,
  type ManagerAvailabilityEvent,
} from '../../src/manager/connection.js';

describe('Manager connection state', () => {
  it('keeps the selected record unavailable across runtime loss until it reloads', () => {
    let state = initialManagerAvailability;
    state = managerAvailabilityTransition(state, 'runtime-ready');
    state = managerAvailabilityTransition(state, 'selection-started');
    state = managerAvailabilityTransition(state, 'selection-ready');
    expect(managerSelectionIsReadable(state)).toBe(true);

    state = managerAvailabilityTransition(state, 'runtime-lost');
    expect(managerActionsAreAvailable(state)).toBe(false);
    expect(managerSelectionIsReadable(state)).toBe(false);
    state = managerAvailabilityTransition(state, 'selection-ready');
    expect(managerSelectionIsReadable(state)).toBe(false);
    state = managerAvailabilityTransition(state, 'runtime-ready');
    expect(managerSelectionIsReadable(state)).toBe(false);
    state = managerAvailabilityTransition(state, 'selection-ready');
    expect(managerSelectionIsReadable(state)).toBe(true);
  });

  it('preserves an unsaved draft and requires review only when the canonical content changed', () => {
    const draft = {base: 'Original record', text: 'Unsaved local edit', uri: 'threadnote://memory/example'};
    expect(reconcileManagerDraft(draft, {content: 'Original record', uri: draft.uri})).toEqual({
      content: draft.text,
      needsReview: false,
    });
    expect(reconcileManagerDraft(draft, {content: 'Changed elsewhere', uri: draft.uri})).toEqual({
      content: draft.text,
      needsReview: true,
    });
    expect(reconcileManagerDraft(draft, {content: 'Another record', uri: 'threadnote://memory/other'})).toEqual({
      content: 'Another record',
      needsReview: false,
    });
  });

  it('never exposes a selected record or mutation action while disconnected', () => {
    const event = fc.constantFrom<ManagerAvailabilityEvent>(
      'runtime-ready',
      'runtime-lost',
      'selection-cleared',
      'selection-started',
      'selection-ready',
      'selection-failed',
    );
    fc.assert(
      fc.property(fc.array(event, {maxLength: 40}), events => {
        let state = initialManagerAvailability;
        for (const next of events) {
          state = managerAvailabilityTransition(state, next);
          if (state.runtime !== 'connected') {
            expect(managerSelectionIsReadable(state)).toBe(false);
            expect(managerActionsAreAvailable(state)).toBe(false);
          }
          if (state.selection === 'loading' || state.selection === 'failed') {
            expect(managerActionsAreAvailable(state)).toBe(false);
          }
        }
      }),
      {numRuns: 100},
    );
  });
});
