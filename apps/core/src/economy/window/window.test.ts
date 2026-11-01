import { describe, expect, it } from 'vitest';
import { type LimitFact, STEP_CLASSES, type StepClass } from '@agentdeck/contracts/core/economy';
import { LIMIT_KINDS } from '@agentdeck/contracts/core/journal';
import { WindowBook, windowHealth } from './book.ts';
import { decideRoute, decideWindow, routeWait, waitsOn } from './window.ts';

/**
 * Судья окна (P19, P115): таблица «вид предела × класс шага». Предупреждение не держит ничего,
 * доля ≥ 90 % откладывает work/review/background, отказ держит сессии только своего маршрута,
 * сброс открывает, исчерпание снимает только человек.
 */

const NOW = 1_000_000;
const fact = (over: Partial<LimitFact>): LimitFact => ({
  routeId: 'r1',
  limitKind: 'window',
  usedPct: null,
  resetAt: NOW + 60_000,
  refusal: false,
  source: 'cli-event',
  at: NOW - 1,
  ...over,
});

const waiting = (facts: LimitFact[], kind = facts[0]!.limitKind): StepClass[] =>
  STEP_CLASSES.filter((cls) => waitsOn(decideWindow(facts, 'r1', kind, NOW), cls));

describe('economy/window — P115 table: limit kind × step class', () => {
  it.each(LIMIT_KINDS.map((k) => [k] as const))(
    '%s: open below 90 percent, held at 90 percent defers work/review/background only, refusal holds every session class',
    (kind) => {
      expect(waiting([fact({ limitKind: kind, usedPct: 89.9 })])).toEqual([]);
      const held = decideWindow([fact({ limitKind: kind, usedPct: 90 })], 'r1', kind, NOW);
      expect(held).toMatchObject({ verdict: 'held', resumeAt: NOW + 60_000 });
      expect(waiting([fact({ limitKind: kind, usedPct: 90 })])).toEqual([
        'work',
        'review',
        'background',
      ]);
      const refused = [fact({ limitKind: kind, refusal: true })];
      expect(decideWindow(refused, 'r1', kind, NOW).verdict).toBe(
        kind === 'budget' ? 'exhausted' : 'refused',
      );
      expect(waiting(refused)).toEqual(['work', 'review', 'background', 'fix']);
    },
  );

  it('fix, final-gate and publish are never in defer, whatever the verdict', () => {
    for (const kind of LIMIT_KINDS)
      for (const f of [fact({ usedPct: 99 }), fact({ refusal: true }), fact({ warning: true })]) {
        const d = decideWindow([{ ...f, limitKind: kind }], 'r1', kind, NOW);
        expect(d.defer).not.toContain('fix');
        expect(d.defer).not.toContain('final-gate');
        expect(d.defer).not.toContain('publish');
      }
    expect(waiting([fact({ refusal: true })])).not.toContain('final-gate');
    expect(waiting([fact({ refusal: true })])).not.toContain('publish');
  });

  it('a refusal holds only that route: other routes continue (P115)', () => {
    const facts = [fact({ refusal: true }), fact({ routeId: 'r2', usedPct: 10 })];
    expect(routeWait(decideRoute(facts, 'r1', NOW), 'work')).toMatchObject({ wait: true });
    expect(routeWait(decideRoute(facts, 'r2', NOW), 'work')).toEqual({
      wait: false,
      resumeAt: null,
      by: [],
    });
    expect(decideRoute(facts, 'r3', NOW)).toEqual([]);
  });
});

describe('economy/window — P19 warning holds nothing; refusal holds; reset resumes', () => {
  it('a CLI warning below 90% is warn and holds nothing', () => {
    const d = decideWindow([fact({ warning: true, usedPct: 75 })], 'r1', 'window', NOW);
    expect(d).toMatchObject({ verdict: 'warn', defer: [], resumeAt: null });
    expect(STEP_CLASSES.some((cls) => waitsOn(d, cls))).toBe(false);
  });

  it('a real refusal holds until its reset; after the reset the route is open again', () => {
    const facts = [fact({ refusal: true, resetAt: NOW + 5 })];
    expect(routeWait(decideRoute(facts, 'r1', NOW), 'fix')).toMatchObject({
      wait: true,
      resumeAt: NOW + 5,
    });
    const later = decideWindow(facts, 'r1', 'window', NOW + 5);
    expect(later).toMatchObject({ verdict: 'open', defer: [] });
  });

  it('budget exhaustion ignores the reset clock; only a newer fact (clear-exhausted) opens it', () => {
    const exhausted = fact({ limitKind: 'budget', refusal: true, resetAt: NOW - 10 });
    expect(decideWindow([exhausted], 'r1', 'budget', NOW)).toMatchObject({
      verdict: 'exhausted',
      resumeAt: null,
    });
    const cleared = fact({ limitKind: 'budget', refusal: false, at: NOW, source: 'core-count' });
    expect(decideWindow([exhausted, cleared], 'r1', 'budget', NOW).verdict).toBe('open');
    expect(routeWait(decideRoute([exhausted], 'r1', NOW), 'work')).toMatchObject({
      wait: true,
      resumeAt: null,
    });
  });

  it('no fact is open (unknown window: run, the refusal is read in-band, G13)', () => {
    expect(decideWindow([], 'r1', 'window', NOW)).toMatchObject({
      verdict: 'open',
      reasons: ['no-fact'],
    });
  });

  it('the latest fact of a pair wins; the book ignores a late older fact', () => {
    const old = fact({ refusal: true, at: NOW - 100 });
    const fresh = fact({ usedPct: 20, at: NOW - 50 });
    expect(decideWindow([fresh, old], 'r1', 'window', NOW).verdict).toBe('open');
    const book = new WindowBook();
    book.observe(fresh);
    book.observe(old);
    expect(book.decide('r1', NOW)[0]!.verdict).toBe('open');
    book.observe(fact({ usedPct: 95, at: NOW }));
    expect(windowHealth(book, NOW)).toEqual({
      routes: [
        {
          routeId: 'r1',
          limitKind: 'window',
          verdict: 'held',
          resumeAt: NOW + 60_000,
          usedPct: 95,
          observedAt: NOW,
        },
      ],
    });
  });

  it('the latest wait among several holding kinds decides the resume time', () => {
    const facts = [
      fact({ usedPct: 95, resetAt: NOW + 10 }),
      fact({ limitKind: 'rate', refusal: true, resetAt: NOW + 30 }),
    ];
    expect(routeWait(decideRoute(facts, 'r1', NOW), 'review')).toMatchObject({
      wait: true,
      resumeAt: NOW + 30,
    });
    expect(routeWait(decideRoute(facts, 'r1', NOW), 'fix').by.map((d) => d.limitKind)).toEqual([
      'rate',
    ]);
  });
});
