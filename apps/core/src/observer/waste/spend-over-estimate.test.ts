import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { journalLines } from '../__fixtures__/selftest.ts';
import { signalDef } from '../catalog.ts';
import { foldObserver, initObserverFold } from '../fold.ts';
import { judgeSignal } from '../judge.ts';
import type { FiredVerdict } from '../observer.types.ts';
import { S1, STEP } from './__fixtures__/ids.ts';
import {
  budgetUsage,
  ESTIMATE_UPPER,
  estimateRow,
  sessionStarted,
  SPEND_OVER,
  SPEND_UNDER,
} from './__fixtures__/spend-over-estimate.ts';
import {
  estimateUpper,
  SPEND_OVER_ESTIMATE_SIGNAL,
  spendOverEstimate,
} from './spend-over-estimate.ts';

/**
 * Расход сверх оценки (этап 11, F3, P143) через настоящую свёртку наблюдателя со ВСЕМИ
 * предикатами реестра и судью по каталогу: сигнал — заметка (`info` + `show`), один за задачу;
 * оценка без истории молчит; повтор строки расхода заменяет, а не прибавляет.
 */

function fold(lines: readonly JournalLine[]): FiredVerdict[] {
  let state = initObserverFold();
  const out: FiredVerdict[] = [];
  for (const line of lines) {
    const step = foldObserver(state, line, { windowOf: () => null, now: () => 0 });
    expect(step.errors).toEqual([]);
    state = step.state;
    out.push(...step.verdicts.filter((v) => v.signal === SPEND_OVER_ESTIMATE_SIGNAL));
  }
  return out;
}

describe('stage 11 spend over the estimate (F3, P143)', () => {
  it('past 2× the history estimate upper bound: one info signal shown in the feed, never a pause', () => {
    const got = fold(SPEND_OVER);
    expect(got).toHaveLength(1);
    const verdict = got[0] as FiredVerdict;
    expect(verdict).toMatchObject({
      subject: SPEND_OVER[0]?.taskId,
      sessionId: S1,
      stepId: STEP,
      key: `${SPEND_OVER_ESTIMATE_SIGNAL}:${SPEND_OVER[0]?.taskId}`,
    });
    expect(verdict.detail).toContain(`spent 21000 budget tokens`);
    expect(verdict.detail).toContain(`upper bound ${ESTIMATE_UPPER}`);
    expect(verdict.inputs).toEqual([4]);
    const def = signalDef(SPEND_OVER_ESTIMATE_SIGNAL);
    expect(def).toBeDefined();
    const decision = judgeSignal(verdict, def as NonNullable<typeof def>);
    expect(decision).toMatchObject({ fired: true, severity: 'info', action: 'show' });
    expect(decision.humanPoint).toBeNull();
  });

  it('near-miss: the same run below 2× the upper bound stays silent', () => {
    expect(fold(SPEND_UNDER)).toEqual([]);
    // Ровно 2× — ещё не «сверх».
    const exact = journalLines([
      estimateRow('history'),
      sessionStarted(S1),
      budgetUsage('m-1', 2 * ESTIMATE_UPPER),
    ]);
    expect(fold(exact)).toEqual([]);
  });

  it('fires once per task: more spend after the signal adds nothing', () => {
    const lines = journalLines([
      estimateRow('history'),
      sessionStarted(S1),
      budgetUsage('m-1', 25_000),
      budgetUsage('m-2', 25_000),
      budgetUsage('m-3', 90_000),
    ]);
    expect(fold(lines)).toHaveLength(1);
    // Сам предикат, без снятия повторов по ключу в свёртке наблюдателя: тоже один вердикт.
    let state = spendOverEstimate.init();
    let verdicts = 0;
    for (const line of lines) {
      const step = spendOverEstimate.step(state, line, { windowOf: () => null, now: () => 0 });
      state = step.state;
      verdicts += step.verdicts.length;
    }
    expect(verdicts).toBe(1);
  });

  it('a no-history estimate stays silent however much is spent', () => {
    const lines = journalLines([
      estimateRow('no-history'),
      sessionStarted(S1),
      budgetUsage('m-1', 900_000),
      budgetUsage('m-2', 900_000),
    ]);
    expect(fold(lines)).toEqual([]);
    expect(estimateUpper('{"basis":"no-history","tokens":null,"spread":null}')).toBeNull();
    expect(estimateUpper('not json')).toBeNull();
    // Судит основание, а не наличие чисел: no-history с числами — тоже тишина.
    const numbered = '{"basis":"no-history","tokens":9000,"spread":[6000,12000]}';
    expect(estimateUpper(numbered)).toBeNull();
    // История без числа — судить не с чем.
    expect(estimateUpper('{"basis":"history","tokens":null,"spread":null}')).toBeNull();
    expect(estimateUpper('{"basis":"history","tokens":0,"spread":[0,0]}')).toBeNull();
    const row = estimateRow('no-history');
    expect(
      fold(
        journalLines([
          { ...row, data: { ...row.data, detail: numbered } },
          sessionStarted(S1),
          budgetUsage('m-1', 900_000),
        ]),
      ),
    ).toEqual([]);
  });

  it('a repeated message row replaces its spend, never adds it twice', () => {
    const lines = journalLines([
      estimateRow('history'),
      sessionStarted(S1),
      budgetUsage('m-1', 15_000),
      budgetUsage('m-1', 15_000),
      budgetUsage('m-1', 15_000),
    ]);
    expect(fold(lines)).toEqual([]);
  });
});
