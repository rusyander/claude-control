import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { newId } from '../../lib/ids/uuidv7.ts';
import { initialState, reduce } from './reduce.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка v12 (этап 11, зона F): принятая карточка приёма (`intake.card`) и класс задачи (решение
 * `classify`, `output.class`) — то, по чему судья `next` пропускает разбор и шаги `onlyFor`.
 */

const TASK = newId();
const BOOT = newId();
const SHA = 'a'.repeat(64);

function line(seq: number, kind: JournalKind, data: unknown): JournalLine {
  return {
    v: 1,
    seq,
    at: 1_000 + seq,
    mono: seq * 10,
    bootId: BOOT,
    taskId: TASK,
    kind,
    actor: 'core',
    data,
  } as JournalLine;
}

const fold = (lines: JournalLine[]): TaskFoldState => lines.reduce(reduce, initialState(TASK));

const card = {
  goal: 'g',
  acceptance: [],
  area: { paths: [], units: [] },
  constraints: [],
  unknowns: [],
  sourceDigest: SHA,
};

const classify = (seq: number, output: unknown) =>
  line(seq, 'decision', {
    decisionId: newId(),
    class: 'classify',
    inputs: [],
    facts: [],
    numbers: {},
    reasons: [],
    output,
  });

describe('fold v12: the lead card and the task class', () => {
  it('the reducer version is at least 12 (v13 pins it)', () => {
    expect(REDUCER_VERSION).toBeGreaterThanOrEqual(12);
  });

  it('a fresh task has no lead field: v11 snapshots fold the same', () => {
    expect(fold([]).lead).toBeUndefined();
  });

  it('intake.card records who accepted the card and its line', () => {
    const state = fold([line(1, 'intake.card', { card, by: 'auto', askId: null })]);
    expect(state.lead).toEqual({ card: { by: 'auto', seq: 1 }, taskClass: null });
  });

  it('a classify decision sets the class; a later one replaces it, the card stays', () => {
    const state = fold([
      line(1, 'intake.card', { card, by: 'human', askId: newId() }),
      classify(2, { class: 'S' }),
      classify(3, { class: 'L' }),
    ]);
    expect(state.lead).toEqual({
      card: { by: 'human', seq: 1 },
      taskClass: { class: 'L', seq: 3 },
    });
  });

  it('an output without a known class leaves the class as it was', () => {
    const state = fold([
      classify(1, { class: 'M' }),
      classify(2, { class: 'XXL' }),
      classify(3, null),
    ]);
    expect(state.lead?.taskClass).toEqual({ class: 'M', seq: 1 });
  });
});
