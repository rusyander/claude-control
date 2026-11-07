import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CREATED,
  SOLO_UNIT,
  deps,
  fakeClock,
  openFresh,
  tempDir,
} from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { learnedFor, readLearnedDurations } from './learned.ts';
import { decideSchedule } from './schedule.ts';
import type { ScheduleCandidate } from './schedule.types.ts';

/**
 * Планировщик (02:80-82) — модельный тест: класс, остаток начатых по возрастанию, новые — самые
 * долгие первыми, FIFO, старение; поток срочных шагов не морит работу (нет голодания).
 */

const cand = (unitId: string, over: Partial<ScheduleCandidate> = {}): ScheduleCandidate => ({
  unitId,
  stepKind: 'work',
  started: false,
  remainingMs: null,
  learnedMs: null,
  waitingSince: 0,
  ...over,
});

const AGING = 60_000;

describe('schedule', () => {
  it('orders by class, then started by remaining ascending, new by learned descending, then FIFO', () => {
    const d = decideSchedule({
      candidates: [
        cand('work-new-short', { learnedMs: 10 }),
        cand('work-new-long', { learnedMs: 99 }),
        cand('work-new-unknown'),
        cand('work-started-far', { started: true, remainingMs: 500 }),
        cand('work-started-near', { started: true, remainingMs: 5 }),
        cand('review', { stepKind: 'review', waitingSince: 9 }),
        cand('fix', { stepKind: 'fix', waitingSince: 9 }),
        cand('publish', { stepKind: 'publish', waitingSince: 9 }),
        cand('bg-late', { stepKind: 'work', learnedMs: 10, waitingSince: 5 }),
      ],
      freeSlots: 2,
      now: 10,
      agingMs: AGING,
    });
    expect(d.order.map((r) => r.unitId)).toEqual([
      'publish',
      'fix',
      'review',
      'work-started-near',
      'work-started-far',
      'work-new-long',
      'work-new-short',
      'bg-late',
      'work-new-unknown',
    ]);
    expect(d.grant).toEqual(['publish', 'fix']);
  });

  it('model: under a steady stream of deliver/fix arrivals a waiting work unit is granted within its aging bound', () => {
    // Каждый такт приходит новый срочный кандидат, слот один. Работа ждёт с момента 0.
    const TICK = 10_000;
    const bound = 3 * AGING; // work → deliver за три класса
    for (const urgent of ['publish', 'fix', 'review'] as const) {
      const queue: ScheduleCandidate[] = [cand('w', { waitingSince: 0 })];
      let grantedAt: number | null = null;
      for (let t = 0; t <= bound + TICK * 2 && grantedAt === null; t += TICK) {
        queue.push(cand(`u${t}`, { stepKind: urgent, waitingSince: t }));
        const d = decideSchedule({ candidates: queue, freeSlots: 1, now: t, agingMs: AGING });
        const got = d.grant[0] as string;
        if (got === 'w') grantedAt = t;
        queue.splice(
          queue.findIndex((c) => c.unitId === got),
          1,
        );
      }
      expect({ urgent, starved: grantedAt === null }).toEqual({ urgent, starved: false });
      expect(grantedAt as number).toBeLessThanOrEqual(bound + TICK);
    }
    // Без старения та же работа голодает — проверка видит именно старение.
    const queue: ScheduleCandidate[] = [cand('w')];
    let granted = false;
    for (let t = 0; t < 50 && !granted; t += 1) {
      queue.push(cand(`u${t}`, { stepKind: 'fix', waitingSince: t }));
      const d = decideSchedule({ candidates: queue, freeSlots: 1, now: t * AGING, agingMs: 0 });
      granted = d.grant[0] === 'w';
      queue.splice(
        queue.findIndex((c) => c.unitId === d.grant[0]),
        1,
      );
    }
    expect(granted).toBe(false);
  });

  describe('seat mode (held given, P141)', () => {
    const R = 'cli-login:claude';
    const seat = (unitId: string, over: Partial<ScheduleCandidate> = {}) =>
      cand(unitId, { route: R, routeCap: null, limit: 4, ...over });

    it('grants while all held seats stay under the candidate limit; the rest wait with a named count', () => {
      const d = decideSchedule({
        candidates: [seat('a'), seat('b'), seat('c')],
        freeSlots: 6,
        now: 0,
        agingMs: AGING,
        held: [{ route: R }, { route: R }],
      });
      expect(d.grant).toEqual(['a', 'b']);
      expect(d.blocked).toEqual({ c: 'slot' });
      expect(d.reasons).toContain('c waits: 4 of 4 seats held');
    });

    it('free slots of the machine cap the grant even under a higher limit', () => {
      const d = decideSchedule({
        candidates: [seat('a', { limit: 6 }), seat('b', { limit: 6 })],
        freeSlots: 1,
        now: 0,
        agingMs: AGING,
        held: [],
      });
      expect(d.grant).toEqual(['a']);
      expect(d.blocked).toEqual({ b: 'slot' });
    });

    it('head of line: a blocked higher-ranked candidate holds everyone below it, even a bigger limit', () => {
      const d = decideSchedule({
        candidates: [
          seat('fix-low', { stepKind: 'fix', limit: 1 }),
          seat('work-high', { limit: 6 }),
        ],
        freeSlots: 5,
        now: 0,
        agingMs: AGING,
        held: [{ route: R }],
      });
      expect(d.order.map((r) => r.unitId)).toEqual(['fix-low', 'work-high']);
      expect(d.grant).toEqual([]);
      expect(d.blocked).toEqual({ 'fix-low': 'slot', 'work-high': 'slot' });
      expect(d.reasons).toContain('work-high waits behind fix-low');
    });

    it('a full route does not hold the head: other routes go, the capped one waits "route"', () => {
      const d = decideSchedule({
        candidates: [
          seat('own', { stepKind: 'fix', route: 'local:own', routeCap: 1 }),
          seat('cloud'),
        ],
        freeSlots: 5,
        now: 0,
        agingMs: AGING,
        held: [{ route: 'local:own' }],
      });
      expect(d.grant).toEqual(['cloud']);
      expect(d.blocked).toEqual({ own: 'route' });
      expect(d.reasons).toContain('own waits: route local:own full (1)');
    });

    it('class order decides who takes the last seat; aging lifts a long-waiting work step over a fresh fix', () => {
      const fresh = decideSchedule({
        candidates: [seat('work', { waitingSince: 0 }), seat('fix', { stepKind: 'fix' })],
        freeSlots: 1,
        now: 0,
        agingMs: AGING,
        held: [],
      });
      expect(fresh.grant).toEqual(['fix']);
      const aged = decideSchedule({
        candidates: [
          seat('work', { waitingSince: 0 }),
          seat('fix', { stepKind: 'fix', waitingSince: 3 * AGING }),
        ],
        freeSlots: 1,
        now: 3 * AGING,
        agingMs: AGING,
        held: [],
      });
      expect(aged.grant).toEqual(['work']);
      expect(aged.order[0]?.why).toBe('work aged +3, new, learned unknown ms');
    });
  });

  it('learned durations come from past journals by area, skip tasks with overrides and unreadable journals', async () => {
    const root = tempDir('learn-');
    const clock = fakeClock();
    const unitRun = async (owned: string[], ms: number, override = false) => {
      const { task } = await openFresh(root, deps({ clock }));
      task.append({ kind: 'task.created', actor: 'core', data: CREATED });
      const unitId = newId();
      task.append({
        kind: 'unit.created',
        actor: 'core',
        unitId,
        data: { ...SOLO_UNIT, unitId, repoKey: 'r1', branch: 'b', ownedPaths: owned },
      });
      const move = (event: 'start' | 'ready', from: string, to: string) =>
        task.append({
          kind: 'unit.transition',
          actor: 'core',
          unitId,
          data: { unitId, event, from, to } as never,
        });
      move('start', 'planned', 'running');
      clock.advance(ms);
      move('ready', 'running', 'ready-to-publish');
      if (override)
        task.append({
          kind: 'override.set',
          actor: 'core',
          data: {
            scope: 'task',
            scopeId: task.taskId,
            field: 'model',
            value: 'm',
            timing: 'now',
            cmdId: newId(),
          } as never,
        });
      task.close();
    };
    await unitRun(['src/api/**'], 1000);
    await unitRun(['src/web'], 3000);
    await unitRun(['docs/**'], 50);
    await unitRun(['src/x'], 999_999, true);
    const broken = newId();
    mkdirSync(join(root, broken));
    writeFileSync(join(root, broken, 'journal.jsonl'), 'garbage\n');

    const fact = await readLearnedDurations(root);
    expect('value' in fact).toBe(true);
    if (!('value' in fact)) return;
    expect(fact.value.samples).toBe(3);
    expect(fact.value.skipped).toBe(1);
    expect(learnedFor(fact.value, 'r1', ['src/new/**'])).toBe(2000);
    expect(learnedFor(fact.value, 'r1', ['docs'])).toBe(50);
    expect(learnedFor(fact.value, 'r1', ['other'])).toBe(1000);
    expect(learnedFor(fact.value, 'r9', ['src'])).toBeNull();
  });
});
