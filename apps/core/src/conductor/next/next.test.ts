import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { initialState, reduce } from '../../journal/reduce/reduce.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { PRESETS, presetOf } from '../scenario/presets.ts';
import { decideSafepoint } from '../safepoint/safepoint.ts';
import { isSplitPoint } from '../split/index.ts';
import { workNow } from '../run/run.ts';
import { decideNext, estimateScope } from './next.ts';
import type { LiveStepFact } from './next.types.ts';

/**
 * Чистый суд `decideNext` над свёрткой (P80 next): входы — только строки журнала и живые факты,
 * ответ — одно действие. Здесь ветки, которых стенд исполнителя не достаёт одной прогонкой.
 */

const TASK = newId();
const FEATURE = presetOf({ id: 'feature', version: 1 })!;

function fold(build: (add: (kind: JournalKind, data: unknown, x?: object) => void) => void) {
  let state: TaskFoldState = initialState(TASK);
  let seq = 0;
  const add = (kind: JournalKind, data: unknown, x: object = {}) => {
    seq += 1;
    const line = {
      v: 1,
      seq,
      at: seq,
      mono: seq * 1000,
      bootId: TASK,
      taskId: TASK,
      kind,
      actor: 'core',
      data,
      ...x,
    };
    state = reduce(state, line as JournalLine);
  };
  build(add);
  return state;
}

const created = {
  title: 't',
  repos: [],
  build: 'b',
  scenario: { id: 'feature', version: 1 },
  profilePins: [],
  modelCeiling: null,
  userLayerHash: null,
  envPin: '',
  requirementsSource: 'text',
  allowedRoutes: [],
  routesSourceLevel: 2,
  origin: null,
  launchPolicy: 'auto',
  ciWait: false,
};
const unit = (unitId: string, after: string[] = []) => ({
  unitId,
  name: 'u',
  repoKey: 'r1',
  branch: 'b',
  ownedPaths: [],
  after,
  contract: false,
  splitId: null,
});

function running(add: (kind: JournalKind, data: unknown, x?: object) => void) {
  add('task.created', created);
  add('task.transition', { taskId: TASK, event: 'launch', from: 'draft', to: 'running' });
}

const decide = (state: TaskFoldState, live: Record<string, LiveStepFact> = {}, workNowMs = 0) =>
  decideNext({ state, scenario: FEATURE, workNowMs, live }).action;

describe('decideNext (pure, P80 next)', () => {
  it('no unit → create one (solo); a planned unit waits for its predecessor, the free one starts', () => {
    expect(decide(fold(running))).toEqual({ kind: 'create-unit' });
    const a = newId();
    const b = newId();
    const state = fold((add) => {
      running(add);
      add('unit.created', unit(b, [a]));
      add('unit.created', unit(a));
    });
    expect(decide(state)).toEqual({ kind: 'start-unit', unitId: a });
  });

  it('turn end: remind once per turn; the same turn again waits; after three → derive-outcome', () => {
    const u = newId();
    const step = newId();
    const sessionId = newId();
    const base = (reminders: number) =>
      fold((add) => {
        running(add);
        add('unit.created', unit(u));
        add('unit.transition', { unitId: u, event: 'start', from: 'planned', to: 'running' });
        add('step.started', {
          stepId: step,
          unitId: u,
          stepKind: 'intake',
          stepDefId: 'intake',
          round: 0,
          scenario: created.scenario,
          budgetMs: 0,
        });
        add('step.transition', { stepId: step, event: 'start', from: 'queued', to: 'running' });
        for (let n = 1; n <= reminders; n += 1) {
          add('step.reminded', { stepId: step, sessionId, turnSeq: 100 + n, count: n });
        }
      });
    const at = (seq: number): Record<string, LiveStepFact> => ({
      [step]: { sessionId, turnEnd: { seq }, ended: false, safe: true },
    });
    expect(decide(base(0), at(101))).toEqual({
      kind: 'remind',
      stepId: step,
      sessionId,
      turnSeq: 101,
      count: 1,
    });
    expect(decide(base(1), at(101))).toMatchObject({ kind: 'wait' });
    expect(decide(base(1), at(102))).toMatchObject({ kind: 'remind', count: 2 });
    expect(decide(base(3), at(104))).toEqual({ kind: 'derive-outcome', stepId: step });
    // Сессия работает — ждать; без сессии в этом процессе — запустить/прикрепить.
    expect(
      decide(base(0), { [step]: { sessionId, turnEnd: null, ended: false, safe: false } }),
    ).toMatchObject({ kind: 'wait', reason: 'session working' });
    expect(decide(base(0))).toEqual({ kind: 'run-step', stepId: step });
  });

  it('paused: not safe → wait; safe → park soft; pause now → park tree', () => {
    const u = newId();
    const step = newId();
    const cmd = newId();
    const paused = (now: boolean) =>
      fold((add) => {
        running(add);
        add('unit.created', unit(u));
        add(
          'command.received',
          {
            kind: 'pause',
            target: { taskId: TASK },
            expectSeq: null,
            fields: { now },
            proof: { token: 'core', nonce: 'absent', peer: 'clear', signature: 'absent' },
          },
          { cmdId: cmd },
        );
        add(
          'task.transition',
          { taskId: TASK, event: 'pause', from: 'running', to: 'paused' },
          { cmdId: cmd },
        );
      });
    const live = (safe: boolean) => ({
      [step]: { sessionId: 's', turnEnd: null, ended: false, safe },
    });
    expect(decide(paused(false), live(false))).toMatchObject({ kind: 'wait' });
    expect(decide(paused(false), live(true))).toEqual({
      kind: 'park-session',
      stepId: step,
      mode: 'soft',
      why: 'pause',
    });
    expect(decide(paused(true), live(false))).toMatchObject({ kind: 'park-session', mode: 'tree' });
    expect(decide(paused(false))).toEqual({ kind: 'wait', reason: 'paused' });
  });

  it('a running step with a budget waits until its deadline (work time), not wall time', () => {
    const u = newId();
    const step = newId();
    const state = fold((add) => {
      running(add);
      add('unit.created', unit(u));
      add('unit.transition', { unitId: u, event: 'start', from: 'planned', to: 'running' });
      add('step.started', {
        stepId: step,
        unitId: u,
        stepKind: 'intake',
        stepDefId: 'intake',
        round: 0,
        scenario: created.scenario,
        budgetMs: 5_000,
      });
      add('step.transition', { stepId: step, event: 'start', from: 'queued', to: 'running' });
    });
    const live = { [step]: { sessionId: 's', turnEnd: null, ended: false, safe: false } };
    const at = state.steps[step]!.workAtStart;
    expect(decide(state, live, at + 4_000)).toEqual({
      kind: 'wait',
      reason: 'session working',
      untilWorkMs: at + 5_000,
    });
    expect(decide(state, live, at + 5_001)).toMatchObject({ kind: 'raise', point: 7 });
  });
});

describe('decideNext: estimating runs only up to the split point (G5/G6)', () => {
  type Add = (kind: JournalKind, data: unknown, x?: object) => void;
  const estimating = (add: Add) => {
    add('task.created', created);
    add('task.transition', { taskId: TASK, event: 'estimate', from: 'draft', to: 'estimating' });
  };
  const done = (add: Add, unitId: string, defId: string) => {
    const stepId = newId();
    add('step.started', {
      stepId,
      unitId,
      stepKind: defId,
      stepDefId: defId,
      round: 0,
      scenario: created.scenario,
      budgetMs: 0,
    });
    add('step.transition', { stepId, event: 'start', from: 'queued', to: 'running' });
    add('step.transition', { stepId, event: 'check', from: 'running', to: 'checking' });
    add('step.transition', { stepId, event: 'checked-green', from: 'checking', to: 'done' });
  };
  const started = (add: Add, u: string) => {
    add('unit.created', unit(u));
    add('unit.transition', { unitId: u, event: 'start', from: 'planned', to: 'running' });
  };

  it('estimateScope keeps exactly the split points of split/flow isSplitPoint, plus what they wait for, in every preset', () => {
    // Судья `next` держит своё правило точки деления (без ввода-вывода деления) — здесь их паритет.
    // Ожидаемая оценка по правилу деления: его точки и всё, от чего они зависят, — и ничего больше.
    const closure = (s: Scenario): string[] => {
      const keep = new Set<string>();
      const visit = (id: string): void => {
        if (keep.has(id)) return;
        keep.add(id);
        for (const dep of s.steps.find((d) => d.id === id)?.after ?? []) visit(dep);
      };
      s.steps.filter((d) => isSplitPoint(s.steps, d)).forEach((d) => visit(d.id));
      return s.steps.filter((d) => keep.has(d.id)).map((d) => d.id);
    };
    // План, не зависящий от разбора: разбор тогда не точка деления и в оценку не входит.
    const detached: Scenario = {
      ...FEATURE,
      steps: FEATURE.steps.map((d) => (d.kind === 'plan' ? { ...d, after: [] } : d)),
    };
    // Нет точки деления (чат) — оценивать нечего: `null` равен пустому замыканию.
    for (const scenario of [...PRESETS, detached]) {
      expect({
        id: scenario.id,
        scope: estimateScope(scenario)?.steps.map((d) => d.id) ?? [],
      }).toEqual({
        id: scenario.id,
        scope: closure(scenario),
      });
    }
    expect(estimateScope(PRESETS.find((p) => p.id === 'chat')!)).toBeNull();
    expect(estimateScope(detached)!.steps.map((d) => d.id)).toEqual(['plan']);
    expect(estimateScope(FEATURE)!.steps.map((d) => d.id)).toEqual(['intake', 'plan']);
    const reviewOnly = PRESETS.find((p) => p.id === 'review-only')!;
    expect(estimateScope(reviewOnly)!.steps.map((d) => d.id)).toEqual(['intake']);
    expect(
      estimateScope({ ...FEATURE, steps: FEATURE.steps.filter((d) => d.kind === 'work') }),
    ).toBeNull();
  });

  it('work time keeps running while estimating (the fold and the live tail agree); awaiting launch does not count', () => {
    // Хвост `workNow` в оценке: иначе срок шага плана (budgetMs) не наступил бы никогда.
    const est = fold(estimating);
    expect(workNow(est, est.lastAt! + 5_000) - est.work.activeMs).toBe(5_000);
    const idle = fold((add) => {
      estimating(add);
      add('task.transition', {
        taskId: TASK,
        event: 'estimated',
        from: 'estimating',
        to: 'awaiting-launch',
      });
    });
    expect(workNow(idle, idle.lastAt! + 5_000)).toBe(idle.work.activeMs);
  });

  it('estimating: unit 0 is created, intake then plan start; after the plan it waits for the split instead of starting work', () => {
    expect(decide(fold(estimating))).toEqual({ kind: 'create-unit' });
    const u = newId();
    expect(decide(fold((add) => (estimating(add), started(add, u))))).toMatchObject({
      kind: 'start-step',
      stepDefId: 'intake',
    });
    expect(
      decide(fold((add) => (estimating(add), started(add, u), done(add, u, 'intake')))),
    ).toMatchObject({ kind: 'start-step', stepDefId: 'plan' });
    const planned = fold((add) => {
      estimating(add);
      started(add, u);
      done(add, u, 'intake');
      done(add, u, 'plan');
    });
    expect(decide(planned)).toEqual({
      kind: 'wait',
      reason: 'estimate: split point done, awaiting the split decision',
    });
    // Тот же журнал после запуска (задача `running`) — дальше идёт работа: сужение только в оценке.
    const launched = fold((add) => {
      estimating(add);
      started(add, u);
      done(add, u, 'intake');
      done(add, u, 'plan');
      add('task.transition', {
        taskId: TASK,
        event: 'estimated',
        from: 'estimating',
        to: 'awaiting-launch',
      });
      add('task.transition', {
        taskId: TASK,
        event: 'launch',
        from: 'awaiting-launch',
        to: 'running',
      });
    });
    expect(decide(launched)).toMatchObject({ kind: 'start-step', stepDefId: 'work' });
    // Сценарий без точки деления в оценке ждёт с причиной, а не запускает что-то.
    const noPoint = { ...FEATURE, steps: FEATURE.steps.filter((d) => d.kind === 'work') };
    expect(
      decideNext({ state: fold(estimating), scenario: noPoint, workNowMs: 0, live: {} }).action,
    ).toEqual({
      kind: 'wait',
      reason: 'estimate: the scenario has no split point',
    });
  });
});

describe('decideNext: protected root after the step ended (F-061)', () => {
  it('a stop signal on a done step closes the unit; the task then fails naming it', () => {
    const u = newId();
    const step = newId();
    const build = (closed: boolean) =>
      fold((add) => {
        running(add);
        add('unit.created', unit(u));
        add('unit.transition', { unitId: u, event: 'start', from: 'planned', to: 'running' });
        add('step.started', {
          stepId: step,
          unitId: u,
          stepKind: 'intake',
          stepDefId: 'intake',
          round: 0,
          scenario: created.scenario,
          budgetMs: 0,
        });
        add('step.transition', { stepId: step, event: 'start', from: 'queued', to: 'running' });
        add('step.transition', { stepId: step, event: 'check', from: 'running', to: 'checking' });
        add('step.transition', {
          stepId: step,
          event: 'checked-green',
          from: 'checking',
          to: 'done',
        });
        add(
          'signal',
          { signal: 'protected-root', severity: 'stop', subject: '/main', detail: 'main: head' },
          { stepId: step },
        );
        if (closed)
          add('unit.transition', { unitId: u, event: 'close', from: 'running', to: 'closed' });
      });
    expect(decide(build(false))).toEqual({
      kind: 'end-unit',
      unitId: u,
      event: 'close',
      reason: 'stopped: protected-root: /main',
    });
    expect(decide(build(true))).toEqual({
      kind: 'fail-task',
      reason: `unit ${u}: stopped: protected-root: /main`,
    });
  });
});

describe('decideSafepoint (pure, P80 safepoint)', () => {
  it('safe only at a turn end with no tool open and no check run in flight', () => {
    const at = { toolsOpen: 0, checksInFlight: 0, atTurnEnd: true };
    expect(decideSafepoint(at).safe).toBe(true);
    expect(decideSafepoint({ ...at, toolsOpen: 1 })).toEqual({
      safe: false,
      reasons: ['1 tool call(s) open'],
    });
    expect(decideSafepoint({ ...at, checksInFlight: 2 }).safe).toBe(false);
    expect(decideSafepoint({ ...at, atTurnEnd: false }).reasons).toEqual(['turn in progress']);
  });
});

describe('decideNext: observer park (stage 8 F10)', () => {
  const u = newId();
  const step = newId();
  const sessionId = newId();
  const parked = (ask: boolean) =>
    fold((add) => {
      running(add);
      add('unit.created', unit(u));
      add('unit.transition', { unitId: u, event: 'start', from: 'planned', to: 'running' });
      add('step.started', {
        stepId: step,
        unitId: u,
        stepKind: 'intake',
        stepDefId: 'intake',
        round: 0,
        scenario: created.scenario,
        budgetMs: 0,
      });
      add('step.transition', { stepId: step, event: 'start', from: 'queued', to: 'running' });
      add(
        'session.started',
        {
          sessionId,
          stepId: step,
          adapter: 'claude',
          cliVersion: '1',
          route: { kind: 'cli-login', id: 'claude-login' },
          hops: [],
          credentialKind: 'none',
          modelAsked: null,
          modelServed: null,
          effort: null,
          hostPid: 1,
          hostStart: 'x',
          cliPid: null,
          cliStart: null,
          cwd: '/w',
          argv: [],
          resumeOf: null,
          cacheAgeMs: null,
        },
        { stepId: step, sessionId },
      );
      if (ask)
        add(
          'signal',
          {
            signal: 'context-growth',
            severity: 'warn',
            action: 'pause-at-safe-point',
            subject: sessionId,
            detail: 'context 130000 tokens = 65% of window 200000',
          },
          { stepId: step, sessionId },
        );
    });
  const fact = (
    safe: boolean,
    turnEnd: { seq: number } | null = null,
  ): Record<string, LiveStepFact> => ({
    [step]: { sessionId, turnEnd, ended: false, safe },
  });

  it('a parkAsked session parks soft at a safe point, before any reminder; not safe → waits naming the signal', () => {
    const state = parked(true);
    expect(state.sessions[sessionId]?.parkAsked?.signal).toBe('context-growth');
    expect(decide(state, fact(true, { seq: 9 }))).toEqual({
      kind: 'park-session',
      stepId: step,
      mode: 'soft',
      why: 'observer',
    });
    expect(decide(state, fact(false))).toEqual({
      kind: 'wait',
      reason: 'observer park (context-growth): not at a safe point',
    });
  });

  it('near-miss: without the ask the same turn end is reminded, not parked; an ended session derives', () => {
    expect(decide(parked(false), fact(true, { seq: 9 }))).toMatchObject({ kind: 'remind' });
    expect(
      decide(parked(true), { [step]: { sessionId, turnEnd: null, ended: true, safe: true } }),
    ).toEqual({ kind: 'derive-outcome', stepId: step });
  });
});
