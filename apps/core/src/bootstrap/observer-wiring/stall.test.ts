import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../../adapters/index.ts';
import { seedSession, SEED_HUMAN_POLICY } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { raiseHumanPoint } from '../../conductor/human/raise.ts';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { createClock, type ClockSource } from '../../platform/clock.ts';
import {
  createLivenessProbe,
  fakeProcessTable,
  type FakeProcessTable,
} from '../../platform/process-identity.ts';
import type { ProcessRow } from '../../platform/process-table.ts';
import { createActivityBook, type ActivityBook, type ToolClassOf } from './activity.ts';
import { attachObserver } from './attach.ts';
import { createStallWatch, type StallWatch, type StallWatchDeps } from './stall.ts';

/**
 * Тишина сессии (этап 8, F9, P18, P56) на настоящем журнале и настоящем наблюдателе
 * (`attachObserver` с реестром и каталогом ядра): кран активности ведёт книгу по событиям потока,
 * тик пишет `silent`, один `deadline` + `session.probe` на эпизод тишины, мёртвый хост — снятие
 * дерева и `host-dead` → lost. Подделаны только таблица процессов ОС (её строки задаёт тест) и
 * монотонное время (число, которое тест двигает); проба жизни — настоящая `createLivenessProbe`.
 */

const MIN = 60_000;
const HOST = process.pid;

interface Rig {
  task: LiveTask;
  sessionId: string;
  stepId: string;
  book: ActivityBook;
  watch: StallWatch;
  table: FakeProcessTable;
  stops: string[];
  notes: string[];
  at: { t: number };
  ev(event: AdapterEvent, inHistory?: boolean): void;
  lines(): JournalLine[];
}

function hostRow(cpuMs: number | null, extra: Partial<ProcessRow> = {}): ProcessRow {
  return { pid: HOST, ppid: 1, start: `start-${HOST}`, startMs: 1, cpuMs, ...extra };
}

async function rig(
  opts: {
    toolP95?: Record<string, number>;
    classOf?: ToolClassOf;
    permitPending?: (sessionId: string) => boolean;
    stopThrows?: boolean;
    now?: () => number;
    options?: StallWatchDeps['options'];
  } = {},
): Promise<Rig> {
  const { task } = await openFresh();
  const s = seedSession(task, { stepKind: 'work' });
  const at = { t: 0 };
  const now = opts.now ?? (() => at.t);
  const notes: string[] = [];
  const note = (event: string) => notes.push(event);
  attachObserver(task, { ctx: { windowOf: () => null, now }, note });
  const book = createActivityBook({
    now,
    note,
    ...(opts.classOf ? { classOf: opts.classOf } : {}),
  });
  const table = fakeProcessTable([
    hostRow(500),
    { ...hostRow(200), pid: HOST + 100000, ppid: HOST },
  ]);
  const stops: string[] = [];
  const watch = createStallWatch({
    activity: book,
    now,
    probe: createLivenessProbe(table, 0, now),
    ...(opts.toolP95 ? { toolP95: () => opts.toolP95! } : {}),
    ...(opts.permitPending ? { permitPending: opts.permitPending } : {}),
    stop: async (_t, sessionId) => {
      stops.push(sessionId);
      if (opts.stopThrows) throw new Error('tree stop failed');
    },
    note,
    options: { stallDefaultMs: 10 * MIN, ...opts.options },
  });
  watch.attach(task);
  const binding = {
    taskId: task.taskId,
    sessionId: s.sessionId,
    stepId: s.stepId,
    unitId: s.unitId,
    stepKind: 'work',
  };
  return {
    task,
    ...s,
    book,
    watch,
    table,
    stops,
    notes,
    at,
    ev: (event, inHistory = false) => book.tap.onEvent(task, binding, event, { inHistory }),
    lines: () => readJournalLines(task.dir, task.taskId).lines,
  };
}

const TURN: AdapterEvent = { type: 'turn.started', attribution: 'a', origin: 'sequence' };
const TURN_END: AdapterEvent = {
  type: 'turn.ended',
  attribution: 'a',
  origin: 'sequence',
  isError: false,
  numTurns: 1,
  text: '',
};
const call = (id: string, name = 'Bash'): AdapterEvent => ({
  type: 'tool.requested',
  toolUseId: id,
  name,
  input: {},
  cliInitiated: false,
});
const result = (id: string): AdapterEvent => ({
  type: 'tool.result',
  toolUseId: id,
  isError: false,
  cliInitiated: false,
});

/** Переходы сессии `event:from→to` по порядку. */
function moves(r: Rig): string[] {
  return r
    .lines()
    .filter((l) => l.kind === 'session.transition' && l.sessionId === r.sessionId)
    .map((l) => {
      const d = (l as JournalLine<'session.transition'>).data;
      return `${d.event}:${d.from}→${d.to}`;
    });
}

const probes = (r: Rig) =>
  r.lines().filter((l) => l.kind === 'session.probe') as JournalLine<'session.probe'>[];
const stallSignals = (r: Rig) =>
  r
    .lines()
    .filter(
      (l) => l.kind === 'signal' && (l as JournalLine<'signal'>).data.signal === 'stall',
    ) as JournalLine<'signal'>[];

async function at(r: Rig, t: number): Promise<void> {
  r.at.t = t;
  await r.watch.tick();
}

describe('stage 8 stall wiring: silent, one probe per quiet episode, lost on a dead host (F9, P18)', () => {
  it('stage 8 stall alive: silent after 60 s of a turn in flight, one deadline + session.probe past the threshold, stall shown through the real observer, step keeps running, nothing stopped', async () => {
    const r = await rig();
    r.ev(TURN);
    await at(r, MIN - 1);
    expect(moves(r)).toEqual(['spawned:starting→live']);
    await at(r, MIN);
    expect(moves(r)).toEqual(['spawned:starting→live', 'silent:live→quiet']);
    await at(r, 10 * MIN - 1);
    expect(probes(r)).toEqual([]);
    await at(r, 10 * MIN);
    expect(moves(r).slice(2)).toEqual(['deadline:quiet→quiet']);
    const [probe] = probes(r);
    expect(probe?.stepId).toBe(r.stepId);
    expect(probe?.data).toMatchObject({
      sessionId: r.sessionId,
      verdict: 'alive',
      cpuDeltaMs: 0,
      quietMs: 10 * MIN,
      thresholdMs: 10 * MIN,
      toolClass: 'model',
    });
    expect(probe?.data.reason).toMatch(/host pid \d+; threshold: no learned p95; cpu = /);
    const [signal] = stallSignals(r);
    expect(signal?.data).toMatchObject({ severity: 'warn', action: 'show', subject: r.sessionId });
    expect(signal?.data.detail).toContain('host alive, CPU flat; shown, not stopped');
    expect(r.task.state.steps[r.stepId]?.state).toBe('running');
    expect(r.task.state.sessions[r.sessionId]?.state).toBe('quiet');
    expect(r.stops).toEqual([]);
    // Тот же эпизод тишины второй пробы не даёт.
    await at(r, 30 * MIN);
    expect(probes(r)).toHaveLength(1);
    expect(r.notes).toEqual([]);
  });

  it('stage 8 stall CPU moving: the tree CPU grew during the quiet window, the probe says moving and still stops nothing; a live event returns the session to live and opens a new episode', async () => {
    const r = await rig();
    r.ev(TURN);
    await at(r, MIN);
    r.table.set([hostRow(2_500), { ...hostRow(700), pid: HOST + 100000, ppid: HOST }]);
    await at(r, 10 * MIN);
    expect(probes(r)[0]?.data.cpuDeltaMs).toBe(2_500);
    expect(stallSignals(r)[0]?.data.detail).toContain('CPU moving (+2500 ms)');
    r.ev(call('t1'));
    expect(moves(r).slice(-1)).toEqual(['output:quiet→live']);
    // Второе живое событие уже не переход: live → live не пишется.
    r.ev(result('t1'));
    expect(moves(r).filter((m) => m.startsWith('output'))).toHaveLength(1);
    await at(r, 11 * MIN);
    expect(moves(r).slice(-1)).toEqual(['silent:live→quiet']);
    await at(r, 20 * MIN);
    expect(probes(r)).toHaveLength(2);
    expect(r.stops).toEqual([]);
  });

  it('stage 8 stall dead host: probe dead, the tree is stopped and the session written host-dead → lost even when the stop throws', async () => {
    const r = await rig({ stopThrows: true });
    r.ev(TURN);
    await at(r, MIN);
    r.table.set([]);
    await at(r, 10 * MIN);
    expect(probes(r)[0]?.data).toMatchObject({ verdict: 'dead', cpuDeltaMs: null });
    expect(r.stops).toEqual([r.sessionId]);
    expect(moves(r).slice(-2)).toEqual(['deadline:quiet→quiet', 'host-dead:quiet→lost']);
    expect(r.task.state.sessions[r.sessionId]?.state).toBe('lost');
    expect(stallSignals(r)[0]?.data.detail).toContain('host dead: session lost');
    expect(r.notes).toEqual(['observer.stall.stop-failed']);
  });

  it('stage 8 stall liveness unknown: the process table is unreadable, the probe says unknown with the reason and nothing is stopped or lost', async () => {
    const r = await rig();
    r.ev(TURN);
    await at(r, MIN);
    r.table.fail('ps exited 1');
    await at(r, 10 * MIN);
    expect(probes(r)[0]?.data).toMatchObject({ verdict: 'unknown', cpuDeltaMs: null });
    expect(r.stops).toEqual([]);
    expect(r.task.state.sessions[r.sessionId]?.state).toBe('quiet');
  });

  it('stage 8 stall threshold from learned p95: a pending exec call waits p95 x3 before the probe, the probe names the class and the learned basis', async () => {
    const classOf: ToolClassOf = (_t, _b, c) => {
      if (c.tool === 'Broken') throw new Error('no mapping');
      return c.tool === 'Bash' ? 'exec' : 'read';
    };
    const r = await rig({ toolP95: { exec: 5 * MIN, read: 1_000 }, classOf });
    r.ev(TURN);
    r.ev(call('t1'));
    // Фоновый вызов самого CLI ход не держит: его класс порог не меняет.
    r.ev({ ...call('bg', 'Read'), cliInitiated: true } as AdapterEvent);
    expect([...r.book.get(r.sessionId)!.pending.entries()]).toEqual([['t1', 'exec']]);
    await at(r, MIN);
    await at(r, 15 * MIN - 1);
    expect(probes(r)).toEqual([]);
    await at(r, 15 * MIN);
    expect(probes(r)[0]?.data).toMatchObject({ toolClass: 'exec', thresholdMs: 15 * MIN });
    expect(probes(r)[0]?.data.reason).toContain('threshold: learned p95 x3, floor 2 min');
    // Классификатор бросил — вызов идёт общим классом, сбой назван.
    r.ev(call('t2', 'Broken'));
    expect(r.book.get(r.sessionId)!.pending.get('t2')).toBe('tool');
    expect(r.notes).toEqual(['observer.activity.class-failed']);
  });

  it('stage 8 stall starting deadline: a session still starting 60 s after attach is stopped as a tree and written deadline starting → ended', async () => {
    const r = await rig();
    const s2 = r.task.append({
      kind: 'session.started',
      actor: 'core',
      stepId: r.stepId,
      sessionId: '01920000-0000-7000-8000-0000000d0001',
      data: {
        ...(r.lines().find((l) => l.kind === 'session.started')!
          .data as JournalLine<'session.started'>['data']),
        sessionId: '01920000-0000-7000-8000-0000000d0001',
      },
    });
    await at(r, 0);
    await at(r, MIN - 1);
    expect(r.stops).toEqual([]);
    await at(r, MIN);
    expect(r.stops).toEqual([s2.sessionId]);
    expect(r.task.state.sessions[s2.sessionId!]?.state).toBe('ended');
    const last = r
      .lines()
      .filter((l) => l.kind === 'session.transition')
      .at(-1) as JournalLine<'session.transition'>;
    expect(last.data).toMatchObject({ event: 'deadline', from: 'starting', to: 'ended' });
  });
});

describe('stage 8 stall near-misses: quiet that is not a stall (F9, F13)', () => {
  it('stage 8 stall near-miss: no turn in flight (turn ended, or never started) never goes silent', async () => {
    const r = await rig();
    await at(r, 5 * MIN);
    r.ev(TURN);
    r.ev(TURN_END);
    await at(r, 30 * MIN);
    expect(moves(r)).toEqual(['spawned:starting→live']);
    expect(probes(r)).toEqual([]);
  });

  it('stage 8 stall near-miss: a permission question in the stream (permit.request last) keeps the session live', async () => {
    const r = await rig();
    r.ev(TURN);
    r.ev({ type: 'permit.request', requestId: 'p1', raw: {} });
    await at(r, 30 * MIN);
    expect(moves(r)).toEqual(['spawned:starting→live']);
    // Вопрос через сервер права (вне потока) — тоже не тишина, пока ядро его не решило.
    let pending = true;
    const out = await rig({ permitPending: () => pending });
    out.ev(TURN);
    out.ev(call('t1'));
    await at(out, 30 * MIN);
    expect(moves(out)).toEqual(['spawned:starting→live']);
    pending = false;
    await at(out, 30 * MIN + 1);
    expect(moves(out).slice(-1)).toEqual(['silent:live→quiet']);
  });

  it('stage 11 stall near-miss: agent/bg lifecycle rows after a permission question do not answer it; only turn progress does', async () => {
    const r = await rig();
    r.ev(TURN);
    r.ev({ type: 'permit.request', requestId: 'p1', raw: {} });
    r.ev({
      type: 'bg.started',
      itemId: 'b1',
      cliTaskId: 'b1',
      toolUseId: 'tu_bg',
      parentToolUseId: null,
      kind: 'background-shell',
      excerpt: 'npm run dev',
    });
    r.ev({ type: 'bg.ended', itemId: 'b1', how: 'exit', exitCode: 0 });
    r.ev({
      type: 'agent.ended',
      cliTaskId: 'a1',
      toolUseId: 'tu_agent',
      how: 'completed',
      usage: null,
      summary: null,
    });
    await at(r, 30 * MIN);
    expect(moves(r)).toEqual(['spawned:starting→live']);
    // Ответ пришёл: поток пошёл дальше (текст хода) — ожидания права больше нет, тишина считается.
    r.ev({ type: 'text.delta', text: 'ok' });
    await at(r, 32 * MIN);
    expect(moves(r).slice(-1)).toEqual(['silent:live→quiet']);
  });

  it('stage 8 stall near-miss: an open human question on the step is waiting for a human, not silence', async () => {
    const r = await rig();
    r.ev(TURN);
    const asked = raiseHumanPoint(
      r.task,
      {
        source: 'blocker',
        stepId: r.stepId,
        sessionId: r.sessionId,
        action: { kind: 'merge', target: 'x' },
        point: null,
        dedupe: null,
        question: 'merge?',
        options: ['yes', 'no'],
        recommendation: 'no',
        blocking: true,
      },
      { policy: SEED_HUMAN_POLICY },
    );
    expect(asked.kind).toBe('asked');
    await at(r, 30 * MIN);
    expect(moves(r)).toEqual(['spawned:starting→live']);
    expect(probes(r)).toEqual([]);
  });

  it('stage 8 stall near-miss: an event that lands while the batched probe is reading the process table cancels the planned silent', async () => {
    const r = await rig();
    r.ev(TURN);
    const real = createLivenessProbe(r.table, 0, () => r.at.t);
    const racing = createStallWatch({
      activity: r.book,
      now: () => r.at.t,
      probe: {
        ...real,
        snapshot: () => {
          r.at.t += 1;
          r.ev(call('mid-probe'));
          return real.snapshot();
        },
      },
      stop: async () => {},
      note: () => {},
    });
    racing.attach(r.task);
    r.at.t = MIN;
    await racing.tick();
    expect(moves(r)).toEqual(['spawned:starting→live']);
  });

  it('stage 8 stall near-miss: replayed history events rebuild the turn but do not refresh activity; counting starts at attach, so no stall on boot', async () => {
    const r = await rig();
    r.at.t = 50 * MIN;
    r.ev(TURN, true);
    r.ev(call('old'), true);
    // Книга знала сессию с прикрепления (t = 0): история её не освежила.
    expect(r.book.get(r.sessionId)?.lastAt).toBe(0);
    expect(r.book.get(r.sessionId)?.turn).toBe(true);
    const fresh = await rig();
    fresh.at.t = 0;
    fresh.ev(TURN);
    await at(fresh, 59_000);
    expect(moves(fresh)).toEqual(['spawned:starting→live']);
  });
});

describe('stage 8 stall P56: active monotonic time, never wall clock or suspended time', () => {
  it('stage 8 stall P56: a 30-min machine suspend and a ±2 h wall shift give no deadline; the probe comes only after 10 active minutes', async () => {
    const src = { wall: 1_700_000_000_000, mono: 1_000 };
    const source: ClockSource = { wall: () => src.wall, mono: () => src.mono };
    const clock = createClock(source);
    const r = await rig({ now: () => clock.activeMono() });
    const step = (ms: number) => {
      for (let i = 0; i < ms / 1_000; i += 1) {
        src.mono += 1_000;
        src.wall += 1_000;
        clock.tick();
      }
    };
    r.ev(TURN);
    step(MIN);
    await r.watch.tick();
    expect(moves(r).slice(-1)).toEqual(['silent:live→quiet']);
    // Сон машины на Windows: монотонные шли, цикл стоял — один разрыв тика.
    src.mono += 30 * MIN;
    src.wall += 30 * MIN;
    expect(clock.tick()?.suspendedMs).toBeGreaterThan(29 * MIN);
    await r.watch.tick();
    // Сдвиг стенных часов на ±2 ч (Linux/macOS сон или ручная правка) — активное время не видит.
    src.wall += 2 * 60 * MIN;
    clock.tick();
    src.wall -= 4 * 60 * MIN;
    clock.tick();
    await r.watch.tick();
    expect(probes(r)).toEqual([]);
    // Тик-разрыв сна сам засчитан одной секундой работы (TICK_MS): 61 + 1 + 538 = 600 с активных.
    step(9 * MIN - 2_000);
    await r.watch.tick();
    expect(probes(r)).toEqual([]);
    step(1_000);
    await r.watch.tick();
    expect(probes(r)).toHaveLength(1);
    expect(probes(r)[0]?.data.quietMs).toBe(10 * MIN);
  });
});
