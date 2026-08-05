import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  managerAutocompleteEntries,
  type ManagerDialogField,
  validateManagerDialogValues,
} from '../../src/manager_dialog.js';

const root = process.cwd();

describe('manager dialogs', () => {
  it('trims every submitted field without dropping optional empty values', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (project, team) => {
        const fields: readonly ManagerDialogField[] = [
          {id: 'project', label: 'Project'},
          {id: 'team', label: 'Team'},
        ];
        const result = validateManagerDialogValues(fields, {
          project: `  ${project}  `,
          team: `\t${team}\n`,
        });

        expect(result).toEqual({
          ok: true,
          values: {project: project.trim(), team: team.trim()},
        });
      }),
    );
  });

  it('reports the first blank required field', () => {
    const fields: readonly ManagerDialogField[] = [
      {id: 'project', label: 'Project', required: true},
      {id: 'topic', label: 'Topic', required: true},
    ];

    expect(validateManagerDialogValues(fields, {project: ' \n ', topic: 'kept'})).toEqual({
      fieldId: 'project',
      ok: false,
    });
  });

  it('deduplicates and filters autocomplete options while offering novel values explicitly', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), {maxLength: 40}), fc.string(), (options, query) => {
        const entries = managerAutocompleteEntries(options, query, true);
        const normalizedQuery = query.trim().toLocaleLowerCase();
        const normalizedOptions = new Set(
          options
            .map(option => option.trim())
            .filter(Boolean)
            .map(option => option.toLocaleLowerCase()),
        );
        const existing = entries.filter(entry => entry.kind === 'existing');
        const normalizedExisting = existing.map(entry => entry.value.toLocaleLowerCase());
        const shouldCreate = normalizedQuery.length > 0 && !normalizedOptions.has(normalizedQuery);

        expect(new Set(normalizedExisting).size).toBe(normalizedExisting.length);
        expect(normalizedExisting.every(option => option.includes(normalizedQuery))).toBe(true);
        expect(entries[0]?.kind === 'create').toBe(shouldCreate);
        if (shouldCreate) expect(entries[0]?.value).toBe(query.trim());
      }),
    );
  });

  it('does not offer creation when the typed value already exists with different casing', () => {
    expect(managerAutocompleteEntries(['Threadnote', ' threadnote '], 'THREADNOTE', true)).toEqual([
      {kind: 'existing', label: 'Threadnote', value: 'Threadnote'},
    ]);
  });

  it('keeps native browser prompts out of every Manager surface', async () => {
    const sources = await Promise.all(
      ['src/manager_ui.tsx', 'src/manager_graph.tsx'].map(file => readFile(join(root, file), 'utf8')),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/\bwindow\.(?:alert|confirm|prompt)\s*\(/);
    }
  });
});
