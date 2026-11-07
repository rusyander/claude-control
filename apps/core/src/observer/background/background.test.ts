import type { BgItem } from '@agentdeck/contracts/core/agents';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { journalLines } from '../__fixtures__/selftest.ts';
import { signalDef } from '../catalog.ts';
import { foldObserver, initObserverFold } from '../fold.ts';
import { judgeSignal } from '../judge.ts';
import type { FiredVerdict } from '../observer.types.ts';
import { S1, sessionEnded, sessionStarted, STEP } from '../integrity/__fixtures__/selftests.ts';
import {
  agentEnded,
  CHILD,
  CHILD_ENDS_FIRST,
  CHILD_OUTLIVES,
  PARENT,
  spawned,
} from './__fixtures__/selftests.ts';
import {
  BG_HANG_AFTER_MS,
  CHILD_OUTLIVED_PARENT_SIGNAL,
  hangStep,
  orphanPlan,
  orphanVerdict,
  type HangMark,
} from './index.ts';

/**
 * Правила сторожа фона (этап 11, P148): предикат «ребёнок пережил родителя» — через настоящую
 * свёртку наблюдателя со всеми предикатами реестра; чистые правила сироты и зависания — по
 * таблице исходов (замеры ОС ведёт `bootstrap/agents-wiring`, её проверяет тест на процессах).
 */

function fold(lines: readonly JournalLine[]): FiredVerdict[] {
  let state = initObserverFold();
  const out: FiredVerdict[] = [];
  for (const line of lines) {
    const step = foldObserver(state, line, { windowOf: () => null, now: () => 0 });
    expect(step.errors).toEqual([]);
    state = step.state;
    out.push(...step.verdicts.filter((v) => v.signal === CHILD_OUTLIVED_PARENT_SIGNAL));
  }
  return out;
}

const bgStarted = (itemId: string, parentToolUseId: string | null) => ({
  kind: 'bg.started' as const,
  sessionId: S1,
  data: {
    itemId,
    kind: 'background-shell',
    excerpt: 'npm run watch',
    ownerChain: {
      taskId: '01900000-0000-7000-8000-000000000000',
      stepId: STEP,
      unitId: null,
      sessionId: S1,
      toolUseId: 'toolu_bash',
      parentToolUseId,
    },
    startedAt: 1_700_000_000_000,
  },
});

const ITEM: BgItem = {
  itemId: 'bg-1',
  kind: 'background-shell',
  excerpt: 'npm run watch',
  ownerChain: {
    taskId: '01900000-0000-7000-8000-000000000000',
    stepId: STEP,
    unitId: null,
    sessionId: S1,
    toolUseId: 'toolu_bash',
    parentToolUseId: null,
  },
  pid: 4242,
  startedAt: 0,
};

describe('stage 11 background watch rules (P148)', () => {
  describe('child-outlived-parent', () => {
    it('a nested subagent still running when its parent subagent ends fires once per child', () => {
      const got = fold(CHILD_OUTLIVES);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({
        subject: CHILD,
        key: `${CHILD_OUTLIVED_PARENT_SIGNAL}:${CHILD}`,
        sessionId: S1,
        stepId: STEP,
      });
      const def = signalDef(CHILD_OUTLIVED_PARENT_SIGNAL);
      expect(judgeSignal(got[0] as FiredVerdict, def as NonNullable<typeof def>)).toMatchObject({
        severity: 'warn',
        action: 'show',
      });
      // Фоновая работа в контексте субагента — тоже ребёнок; конец её самой снимает её с учёта.
      const bg = journalLines([
        sessionStarted(S1),
        spawned(PARENT, null),
        bgStarted('bg-under', PARENT),
        bgStarted('bg-done', PARENT),
        { kind: 'bg.ended', data: { itemId: 'bg-done', how: 'exit', endedAt: 1 } },
        agentEnded(PARENT),
      ]);
      expect(fold(bg).map((v) => v.subject)).toEqual(['bg-under']);
    });

    it('near-miss: the child ended first, or only the session ended, stays silent', () => {
      expect(fold(CHILD_ENDS_FIRST)).toEqual([]);
      const sessionOnly = journalLines([
        sessionStarted(S1),
        bgStarted('bg-main', null),
        spawned(PARENT, null),
        sessionEnded,
      ]);
      expect(fold(sessionOnly)).toEqual([]);
    });
  });

  describe('orphan plan', () => {
    it('an alive owner is left alone, whatever the process does', () => {
      for (const live of ['alive', 'gone', 'unknown'] as const)
        expect(orphanPlan(ITEM, null, live)).toEqual({ do: 'none' });
    });

    it('an ended owner: alive process → reap, gone or no pid → close lost, unpinned identity → name only', () => {
      expect(orphanPlan(ITEM, 'session ended', 'alive').do).toBe('reap');
      expect(orphanPlan(ITEM, 'session ended', 'gone').do).toBe('close-lost');
      expect(orphanPlan({}, 'session ended', 'alive').do).toBe('close-lost');
      const unpinned = orphanPlan(ITEM, 'host dead', 'unknown');
      expect(unpinned.do).toBe('name-only');
      expect('reason' in unpinned && unpinned.reason).toContain('never pinned');
    });

    it('the verdict names what was reaped, or what was not and why; one key per item', () => {
      const reaped = orphanVerdict(ITEM, 'session ended', { reaped: true, rid: 'r-1' });
      expect(reaped).toMatchObject({ signal: 'bg-orphan', key: 'bg-orphan:bg-1', stepId: STEP });
      expect(reaped.detail).toContain('reaped through resource r-1');
      const kept = orphanVerdict(ITEM, 'host dead', { reaped: false, why: 'kill refused' });
      expect(kept.detail).toContain('NOT reaped: kill refused');
    });
  });

  describe('hang step', () => {
    it('a still output past the limit fires once; a size change restarts the count', () => {
      let mark: HangMark | undefined;
      const fired: number[] = [];
      const at = (t: number, size: number) => {
        const r = hangStep(ITEM, mark, size, t, 1000);
        mark = r.mark;
        if (r.verdict) fired.push(t);
      };
      at(0, 10);
      at(900, 10);
      at(1500, 20); // вырос — отсчёт заново
      at(2400, 20);
      at(2600, 20); // стоит 1100 мс — сигнал
      at(9000, 20); // второй раз — нет
      expect(fired).toEqual([2600]);
      expect(BG_HANG_AFTER_MS).toBe(600_000);
    });

    it('servers and monitors, and items without an output file, never hang', () => {
      for (const kind of ['server', 'monitor'] as const) {
        let mark: HangMark | undefined;
        for (const t of [0, 5000]) {
          const r = hangStep({ ...ITEM, kind }, mark, 10, t, 1000);
          mark = r.mark;
          expect(r.verdict).toBeNull();
        }
      }
      expect(hangStep(ITEM, undefined, null, 0, 0).verdict).toBeNull();
    });
  });
});
