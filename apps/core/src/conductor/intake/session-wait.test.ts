import { describe, expect, it } from 'vitest';
import { learnFrom, samplesOfJournal } from '../../economy/learned/index.ts';
import { deps, fakeClock, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { seedSession } from '../model-tools/__fixtures__/seed.ts';
import { recordedSessionWait, sessionMedianOf, sessionWaitOf } from './session-wait.ts';

const seats = (holders: number, slotWaiters = 0) => ({ value: { holders, slotWaiters } });
const HISTORY = { medianMs: 60_000, samples: 3 };

describe('stage 11 W3-16 sessionWaitOf: expected wait for the first session seat, a pure function of recorded facts', () => {
  it.each([
    // [capacity, holders, slot waiters, history, wait]
    [4, 0, 0, HISTORY, 0],
    [4, 3, 0, HISTORY, 0],
    [4, 3, 0, null, 0],
    [4, 4, 0, HISTORY, 60_000],
    [4, 4, 3, HISTORY, 60_000],
    [4, 4, 4, HISTORY, 120_000],
    [2, 5, 0, HISTORY, 120_000],
    [1, 1, 2, HISTORY, 180_000],
    [4, 4, 0, null, null],
  ] as const)(
    'capacity %i, %i holding, %i waiting for a seat, history %o → %o',
    (capacity, holders, waiters, history, wait) => {
      const got = sessionWaitOf({
        capacity,
        occupancy: seats(holders, waiters),
        ...(history ?? { medianMs: null, samples: 0 }),
      });
      expect(got.waitMs).toBe(wait);
      expect(got.why).not.toBe('');
    },
  );

  it('same facts → same number; unreadable seats or a capacity under 1 → null with the reason named', () => {
    const facts = { capacity: 2, occupancy: seats(3, 1), ...HISTORY };
    expect(sessionWaitOf(facts)).toEqual(sessionWaitOf({ ...facts }));
    const unknown = sessionWaitOf({ ...facts, occupancy: { unknown: 'EACCES' } });
    expect(unknown).toMatchObject({ waitMs: null, holders: null });
    expect(unknown.why).toContain('EACCES');
    expect(sessionWaitOf({ ...facts, capacity: 0 }).waitMs).toBeNull();
  });

  it('sessionMedianOf: no table or a table without session history → no samples', () => {
    expect(sessionMedianOf(null)).toEqual({ medianMs: null, samples: 0 });
    expect(sessionMedianOf(learnFrom([]))).toEqual({ medianMs: null, samples: 0 });
  });

  it('recordedSessionWait reads the last journaled row; a foreign shape is null', () => {
    const row = (detail: string) =>
      ({ kind: 'signal', data: { signal: 'lead-session-wait', detail } }) as never;
    expect(recordedSessionWait([])).toBeNull();
    expect(recordedSessionWait([row('{"waitMs":5}'), row('{"waitMs":7}')])).toBe(7);
    expect(recordedSessionWait([row('{"waitMs":-1}')])).toBeNull();
    expect(recordedSessionWait([row('{broken')])).toBeNull();
  });
});

describe('stage 11 W3-16 learned session durations: finished sessions only, machine sleep excluded', () => {
  function session(
    task: LiveTask,
    clock: ReturnType<typeof fakeClock>,
    ms: number,
    opts: { stepKind?: string; end?: 'exited' | 'host-dead' | 'unstarted'; sleptMs?: number } = {},
  ): void {
    const { sessionId } = seedSession(task, { stepKind: opts.stepKind ?? 'work' });
    if (opts.end !== 'unstarted')
      task.append({
        kind: 'session.transition',
        actor: 'core',
        sessionId,
        data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
      });
    clock.advance(ms);
    if (opts.sleptMs)
      task.append({
        kind: 'clock.jump',
        actor: 'core',
        data: {
          wallDeltaMs: opts.sleptMs,
          monoDeltaMs: 0,
          suspendedMs: opts.sleptMs,
          wallShiftMs: 0,
        },
      });
    const from = opts.end === 'unstarted' ? 'starting' : 'live';
    const lost = opts.end === 'host-dead';
    task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      data: {
        sessionId,
        event: lost ? 'host-dead' : 'exited',
        from,
        to: lost ? 'lost' : 'ended',
      },
    });
  }

  it('work sessions count; chat, lost and never-started ones do not; slept time is subtracted; median over journals', async () => {
    const clock = fakeClock();
    const { task, taskId } = await openFresh(undefined, deps({ clock }));
    session(task, clock, 90_000);
    session(task, clock, 300_000, { sleptMs: 200_000 });
    session(task, clock, 7_200_000, { stepKind: 'chat' });
    session(task, clock, 50_000, { end: 'host-dead' });
    session(task, clock, 50_000, { end: 'unstarted' });
    task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    const samples = samplesOfJournal(taskId, readJournalLines(task.dir, taskId).lines)!;
    task.close();
    expect(samples.sessionMs).toEqual([90_000, 100_000]);
    const table = learnFrom([samples, { ...samples, sessionMs: [120_000] }]);
    expect(table.sessions).toEqual({ medianMs: 100_000, samples: 3 });
    // Вклад старого кэша без `sessionMs` образцов не даёт, но и не роняет таблицу.
    const { sessionMs: _old, ...legacy } = samples;
    expect(learnFrom([legacy]).sessions).toEqual({ medianMs: null, samples: 0 });
  });
});
