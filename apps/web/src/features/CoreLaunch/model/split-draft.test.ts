import { describe, expect, it } from 'vitest';
import { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { SplitProposal } from './launch.types';
import {
  addUnit,
  draftOfSplit,
  editSplitFields,
  patchUnit,
  removeUnit,
  renameUnit,
  splitDirty,
  splitProblems,
  toggleDep,
} from './splitDraft';

/**
 * Редактор деления: черновик из предложения, правки, проверка до ядра и поля `edit-split`,
 * которые принимает схема команды ядра (каждое поле единицы названо, P42).
 */

const SPLIT: SplitProposal = {
  splitId: '01a19701-3a30-7000-8d2f-ebe5ef2ea4b5',
  by: 'plan',
  decided: 'accepted',
  seq: 12,
  units: [
    {
      name: 'api',
      repoKey: 'repo-1',
      ownedPaths: ['src/api/**'],
      deps: [],
      contract: true,
      estimate: { minutes: 5, tokens: 1000 },
    },
    {
      name: 'ui',
      repoKey: 'repo-1',
      ownedPaths: ['src/ui/**', 'src/app.tsx'],
      deps: ['api'],
      contract: false,
      estimate: { minutes: null, tokens: null },
    },
  ],
};

describe('core split editor', () => {
  it('an untouched draft is clean and maps back to the proposal', () => {
    const units = draftOfSplit(SPLIT);
    expect(splitDirty(units, SPLIT)).toBe(false);
    expect(splitProblems(units)).toEqual([]);
    const fields = editSplitFields(SPLIT.splitId, units);
    expect(fields.units[1]).toEqual({
      name: 'ui',
      ownedPaths: ['src/ui/**', 'src/app.tsx'],
      deps: ['api'],
      repo: 'repo-1',
      contract: false,
    });
    expect(COMMAND_FIELDS['edit-split'].safeParse(fields).success).toBe(true);
  });

  it('rename carries dependants along; removal drops the dangling dependency', () => {
    let units = draftOfSplit(SPLIT);
    const api = units[0]!.key;
    units = renameUnit(units, api, 'backend');
    expect(units[1]!.deps).toEqual(['backend']);
    expect(splitDirty(units, SPLIT)).toBe(true);
    units = removeUnit(units, units[0]!.key);
    expect(units).toHaveLength(1);
    expect(units[0]!.deps).toEqual([]);
  });

  it('names empty, duplicate, pathless, self and unknown dependencies before the core sees them', () => {
    let units = addUnit(draftOfSplit(SPLIT), 'repo-1');
    const fresh = units[2]!.key;
    expect(splitProblems(units)).toEqual([
      { unitKey: fresh, code: 'name-empty' },
      { unitKey: fresh, code: 'paths-empty' },
    ]);
    units = renameUnit(units, fresh, 'ui');
    units = patchUnit(units, fresh, { ownedPaths: 'docs/**\n\n' });
    units = toggleDep(units, fresh, 'ui');
    units = toggleDep(units, fresh, 'ghost');
    const codes = splitProblems(units).map((p) => p.code);
    expect(codes).toEqual(['name-duplicate', 'name-duplicate', 'dep-self', 'dep-unknown']);
    units = toggleDep(units, fresh, 'ghost');
    expect(units[2]!.deps).toEqual(['ui']);
    expect(editSplitFields(SPLIT.splitId, units).units[2]!.ownedPaths).toEqual(['docs/**']);
    expect(splitProblems([])).toEqual([{ unitKey: null, code: 'no-units' }]);
  });
});
