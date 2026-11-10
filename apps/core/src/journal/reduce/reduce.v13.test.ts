import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { newId } from '../../lib/ids/uuidv7.ts';
import { initialState, reduce } from './reduce.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка v13 (этап 11): утверждение деления человеком (02 §Split, точка 10) идёт после решения
 * проверки — `accepted` / `edited` → `approved`. Любое другое повторное решение — аномалия.
 */

const TASK = newId();
const BOOT = newId();
const SPLIT = newId();
const STEP = newId();

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

type Outcome = 'accepted' | 'approved' | 'edited' | 'refused';

const proposed = line(1, 'split.proposed', { splitId: SPLIT, stepId: STEP, by: 'plan', units: [] });
const decided = (seq: number, outcome: Outcome, by: 'core' | 'human') =>
  line(seq, 'split.decided', { splitId: SPLIT, outcome, by, decisionSeq: seq - 1 });

const twice = `split ${SPLIT} decided twice`;

describe('fold v13: the human approval of a checked split', () => {
  it('the reducer version is at least 13 (v14: stage 12, `reduce.v14.test.ts`)', () => {
    expect(REDUCER_VERSION).toBeGreaterThanOrEqual(13);
  });

  it.each([
    ['accepted', 'core'],
    ['edited', 'human'],
  ] as const)('%s by the check, then approved by the human → approved, no anomaly', (first, by) => {
    const s = fold([proposed, decided(2, first, by), decided(3, 'approved', 'human')]);
    expect(s.splits[SPLIT]?.state).toBe('approved');
    expect(s.anomalies).toEqual([]);
  });

  it.each([
    ['refused', 'core', 'approved', 'human'],
    ['approved', 'human', 'approved', 'human'],
    ['accepted', 'core', 'approved', 'core'],
    ['accepted', 'core', 'accepted', 'core'],
    ['accepted', 'core', 'refused', 'core'],
    ['edited', 'human', 'edited', 'human'],
  ] as const)(
    '%s by %s, then %s by %s → anomaly, the state stays',
    (first, firstBy, second, by) => {
      const s = fold([proposed, decided(2, first, firstBy), decided(3, second, by)]);
      expect(s.splits[SPLIT]?.state).toBe(first);
      expect(s.anomalies).toEqual([{ seq: 3, reason: twice }]);
    },
  );
});
