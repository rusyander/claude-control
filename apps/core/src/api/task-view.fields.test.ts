import { describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { scenarioViewSchema, splitViewSchema } from '@agentdeck/contracts/core/task-view';
import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { scenarioOf, splitOf } from './task-view.ts';

/**
 * Деление в виде задачи (этап 9): экран запуска показывает единицы последнего предложенного
 * деления и решение по нему из вида, а не из своей свёртки потока. Единицы — только в строке
 * `split.proposed`, решение — в свёртке ядра.
 */

const unit = (name: string) => ({
  name,
  repoKey: 'repo-a',
  ownedPaths: [`src/${name}/**`],
  deps: [],
  contract: false,
  estimate: { minutes: 30, tokens: null },
});

function proposed(seq: number, splitId: string, names: string[]): JournalLine {
  return {
    seq,
    kind: 'split.proposed',
    data: { splitId, stepId: null, by: 'plan', units: names.map(unit) },
  } as unknown as JournalLine;
}

const stateWith = (splits: Record<string, { state: string }>) =>
  ({ splits }) as unknown as TaskFoldState;

describe('task view split (stage 9)', () => {
  it('the last proposed split with its units and the fold decision; no proposal → null', () => {
    const first = newId();
    const second = newId();
    const lines = [proposed(3, first, ['a']), proposed(9, second, ['b', 'c'])];
    const view = splitOf(
      stateWith({ [first]: { state: 'refused' }, [second]: { state: 'approved' } }),
      lines,
    );
    expect(view).toEqual({
      splitId: second,
      seq: 9,
      by: 'plan',
      state: 'approved',
      units: [unit('b'), unit('c')],
    });
    expect(splitViewSchema.safeParse(view).success).toBe(true);
    // Решения ещё нет — деление «предложено», а не пропало.
    expect(splitOf(stateWith({}), lines)?.state).toBe('proposed');
    expect(splitOf(stateWith({}), [])).toBeNull();
  });
});

describe('task view scenario (stage 9)', () => {
  it('the task scenario and its pending change, without the fold-internal refusal counter', () => {
    const ref = { id: 'bug-fix', version: 1 };
    const to = { id: 'my-flow', version: 3 };
    const state = {
      scenario: { ref, pending: { to, applyNow: false }, rejected: 2 },
    } as unknown as TaskFoldState;
    const view = scenarioOf(state);
    expect(view).toEqual({ ref, pending: { to, applyNow: false } });
    expect(scenarioViewSchema.safeParse(view).success).toBe(true);
    expect(scenarioOf({ scenario: null } as unknown as TaskFoldState)).toBeNull();
  });
});
