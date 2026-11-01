import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { foldObserver, initObserverFold, withKeys } from './fold.ts';
import type { Predicate, PredicateCtx, SignalVerdict } from './observer.types.ts';

/**
 * Свёртка наблюдателя (этап 8, F2): чистая, ключ повтора выходит один раз за жизнь задачи, ключи
 * прошлых решений не выходят вовсе, сбой одного предиката не останавливает прочие.
 */

const CTX: PredicateCtx = { windowOf: () => null, now: () => 0 };
const line = (seq: number): JournalLine => ({ seq }) as unknown as JournalLine;

/** Срабатывает на каждой строке с одним и тем же ключом; считает строки. */
const repeating: Predicate<number> = {
  ids: ['stall'],
  init: () => 0,
  step: (n, l) => ({
    state: n + 1,
    verdicts: [
      {
        fired: true,
        signal: 'stall',
        subject: 's1',
        detail: `seq ${l.seq}`,
        reasons: [],
        key: 'stall:s1',
      } satisfies SignalVerdict,
    ],
  }),
};

const throwing: Predicate<number> = {
  ids: ['window'],
  init: () => 0,
  step: () => {
    throw new Error('boom');
  },
};

describe('stage 8 observer fold', () => {
  it('a key fires once: the second line with the same key gives no verdict, state still moves', () => {
    const preds = [repeating as Predicate];
    const first = foldObserver(initObserverFold(preds), line(1), CTX, preds);
    expect(first.verdicts.map((v) => v.detail)).toEqual(['seq 1']);
    const second = foldObserver(first.state, line(2), CTX, preds);
    expect(second.verdicts).toEqual([]);
    expect(second.state.states).toEqual([2]);
  });

  it('keys of decisions already written (withKeys) never fire again', () => {
    const preds = [repeating as Predicate];
    const fold = withKeys(initObserverFold(preds), ['stall:s1']);
    expect(foldObserver(fold, line(1), CTX, preds).verdicts).toEqual([]);
  });

  it('a throwing predicate is named in errors and keeps its state; the others still fold', () => {
    const preds = [throwing as Predicate, repeating as Predicate];
    const step = foldObserver(initObserverFold(preds), line(7), CTX, preds);
    expect(step.errors).toEqual(['window at seq 7: boom']);
    expect(step.state.states).toEqual([0, 1]);
    expect(step.verdicts).toHaveLength(1);
  });

  it('the fold is pure: the input fold is not changed', () => {
    const preds = [repeating as Predicate];
    const start = initObserverFold(preds);
    foldObserver(start, line(1), CTX, preds);
    expect(start.states).toEqual([0]);
    expect([...start.keys]).toEqual([]);
  });
});
