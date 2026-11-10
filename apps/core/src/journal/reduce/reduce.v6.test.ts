import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { newId } from '../../lib/ids/uuidv7.ts';
import { initialState, reduce } from './reduce.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка v6 (CD§10): виды этапа 4 ложатся в состояние, противоречие — аномалия, запись не
 * тронута. Каждое поле, по которому решает `conductor/next`, рождается только строкой журнала.
 */

const TASK = newId();
const BOOT = newId();
const UNIT = newId();
const STEP = newId();
const SESSION = newId();
const REQ = newId();
const ASK = newId();
const CMD = newId();
const PART = newId();
const SCEN = { id: 'feature', version: 1 };

function line(seq: number, kind: JournalKind, data: unknown, extra: Partial<JournalLine> = {}) {
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
    ...extra,
  } as JournalLine;
}

function fold(lines: JournalLine[]): TaskFoldState {
  return lines.reduce(reduce, initialState(TASK));
}

const created = line(1, 'task.created', {
  title: 't',
  repos: [],
  build: 'b',
  scenario: SCEN,
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
});
const launch = line(2, 'task.transition', {
  taskId: TASK,
  event: 'launch',
  from: 'draft',
  to: 'running',
});
const unit = line(3, 'unit.created', {
  unitId: UNIT,
  name: 'api',
  repoKey: 'r1',
  branch: 'agentdeck/x',
  ownedPaths: ['src/**'],
  after: [],
  contract: true,
  splitId: null,
});
const step = (seq: number, id = STEP, round = 0, scenario = SCEN) =>
  line(seq, 'step.started', {
    stepId: id,
    unitId: UNIT,
    stepKind: 'work',
    stepDefId: 'work',
    round,
    scenario,
    budgetMs: 60_000,
  });
const move = (seq: number, event: string, from: string, to: string, id = STEP) =>
  line(seq, 'step.transition', { stepId: id, event, from, to });
const BASE = [created, launch, unit];

describe('reduce v6 (stage 4 fold, CD§10)', () => {
  it('folds unit, step, requirement and split facts with their seq and work time', () => {
    const s = fold([
      ...BASE,
      line(4, 'requirement.extracted', {
        requirementId: REQ,
        ordinal: 1,
        text: 'кнопка показывает ошибку',
        source: 'request',
        stepId: null,
      }),
      step(5),
      line(6, 'requirement.verdict', {
        requirementId: REQ,
        verdict: 'unknown',
        evidence: [],
        reason: 'derived',
        decisionSeq: 5,
      }),
      line(7, 'requirement.reviewed', { stepId: STEP, complete: false, added: [] }),
      line(8, 'split.proposed', { splitId: CMD, stepId: STEP, by: 'plan', units: [] }),
      line(9, 'split.decided', { splitId: CMD, outcome: 'accepted', by: 'core', decisionSeq: 8 }),
      line(10, 'unit.created', { ...unit.data, unitId: PART, splitId: CMD }),
    ]);
    expect(s.reducer).toBe(REDUCER_VERSION);
    // Версию пинит свёртка последнего этапа (`reduce.v7.test.ts`); поля v6 в ней остаются.
    expect(REDUCER_VERSION).toBeGreaterThanOrEqual(6);
    expect(s.anomalies).toEqual([]);
    expect(s.units[UNIT]).toMatchObject({
      state: 'planned',
      name: 'api',
      repoKey: 'r1',
      ownedPaths: ['src/**'],
      contract: true,
      createdSeq: 3,
    });
    // Рабочее время задачи на старте шага: строки 3..5 по 10 мс mono после запуска (running).
    expect(s.steps[STEP]).toMatchObject({
      stepDefId: 'work',
      round: 0,
      startedSeq: 5,
      budgetMs: 60_000,
      workAtStart: 30,
      reminders: 0,
      remindedTurns: [],
      stops: [],
    });
    expect(s.requirements[REQ]).toEqual({
      ordinal: 1,
      text: 'кнопка показывает ошибку',
      source: 'request',
      verdict: 'unknown',
      evidence: [],
    });
    expect(s.extractionReview).toEqual({ complete: false, seq: 7 });
    // Состав деления — из `unit.created.splitId`: единица без деления в список не попадает.
    expect(s.splits[CMD]).toEqual({ state: 'accepted', by: 'plan', units: [PART] });
  });

  it('P16 reminders: one per turn end, counted without gaps; a second for the same turn is an anomaly', () => {
    const remind = (seq: number, turnSeq: number, count: number) =>
      line(seq, 'step.reminded', { stepId: STEP, sessionId: SESSION, turnSeq, count });
    const s = fold([...BASE, step(4), remind(5, 4, 1), remind(6, 5, 2), remind(7, 5, 3)]);
    expect(s.steps[STEP]).toMatchObject({ reminders: 2, remindedTurns: [4, 5] });
    expect(s.anomalies).toEqual([{ seq: 7, reason: 'step.reminded: turn 5 reminded twice' }]);
    const gap = fold([...BASE, step(4), remind(5, 4, 2)]);
    expect(gap.steps[STEP]?.reminders).toBe(0);
    expect(gap.anomalies[0]?.reason).toBe('step.reminded: count 2 after 0');
  });

  it('step.ended records the outcome only when the machine already stands in that end', () => {
    const ended = (seq: number, outcome: string, basis = 'derived') =>
      line(seq, 'step.ended', { stepId: STEP, outcome, basis, reason: 'r' });
    const early = fold([...BASE, step(4), move(5, 'start', 'queued', 'running'), ended(6, 'done')]);
    expect(early.steps[STEP]?.outcome).toBeUndefined();
    expect(early.anomalies[0]?.reason).toBe('step.ended: done but step is running');
    const ok = fold([
      ...BASE,
      step(4),
      move(5, 'start', 'queued', 'running'),
      move(6, 'check', 'running', 'checking'),
      move(7, 'checked-green', 'checking', 'done'),
      ended(8, 'done'),
      ended(9, 'done'),
    ]);
    expect(ok.steps[STEP]).toMatchObject({ outcome: 'done', basis: 'derived', reason: 'r' });
    expect(ok.anomalies.map((a) => a.reason)).toEqual([`step.ended: ${STEP} ended twice`]);
  });

  it('checked-red marks the step for a next round; step budget extension; stop signal on the step', () => {
    const s = fold([
      ...BASE,
      step(4),
      move(5, 'start', 'queued', 'running'),
      move(6, 'check', 'running', 'checking'),
      move(7, 'checked-red', 'checking', 'running'),
      line(8, 'budget.state', { scope: `step:${STEP}`, spent: 60_000, limit: 120_000 }),
      line(9, 'budget.state', { scope: 'task', spent: 1, limit: null }),
      line(
        10,
        'signal',
        { signal: 'protected-root', severity: 'stop', subject: '/main', detail: 'main: head' },
        { stepId: STEP },
      ),
      line(
        11,
        'signal',
        { signal: 'x', severity: 'warn', subject: 's', detail: '' },
        {
          stepId: STEP,
        },
      ),
    ]);
    expect(s.steps[STEP]).toMatchObject({
      state: 'running',
      red: { seq: 7 },
      budgetMs: 120_000,
      extensions: 1,
      stops: ['protected-root: /main'],
    });
    expect(s.anomalies).toEqual([]);
  });

  it('asks carry source, dedupe and step; a late answer is kept and marked; a second answer is an anomaly', () => {
    const asked = line(
      4,
      'human.asked',
      {
        askId: ASK,
        point: 6,
        source: 'round-cap',
        dedupe: 'round-cap:u:review:2',
        question: 'q',
        options: ['a', 'b'],
        defaultAction: null,
      },
      { stepId: STEP },
    );
    const s = fold([
      ...BASE,
      asked,
      line(5, 'ask.transition', { askId: ASK, event: 'expire', from: 'open', to: 'expired' }),
      line(6, 'human.answered', { askId: ASK, answer: 'a', channel: 'panel' }),
      line(7, 'human.answered', { askId: ASK, answer: 'b', channel: 'panel' }),
    ]);
    expect(s.asks[ASK]).toEqual({
      state: 'expired',
      point: 6,
      source: 'round-cap',
      dedupe: 'round-cap:u:review:2',
      stepId: STEP,
      lateAnswer: true,
      answer: 'a',
      // v14 (этап 12): запись вопроса хранит действие по умолчанию.
      defaultAction: null,
    });
    expect(s.anomalies.map((a) => a.reason)).toEqual([`human.answered: ${ASK} answered twice`]);
  });

  it('scenario edit waits for the next step on the new version; overlay rejections counted', () => {
    const v2 = { id: 'feature', version: 2 };
    const edited = line(4, 'scenario.edited', {
      cmdId: CMD,
      from: SCEN,
      to: v2,
      diff: {},
      applyNow: false,
    });
    const overlay = line(5, 'scenario.overlay', {
      scenario: SCEN,
      applied: [],
      rejected: [{ level: 4, path: 'steps.*.roundCap', value: 9, reason: 'widens' }],
    });
    const before = fold([...BASE, edited, overlay, step(6)]);
    expect(before.scenario).toEqual({
      ref: SCEN,
      pending: { to: v2, applyNow: false },
      rejected: 1,
    });
    const after = fold([...BASE, edited, overlay, step(6, newId(), 0, v2)]);
    expect(after.scenario).toEqual({ ref: v2, pending: null, rejected: 1 });
  });

  it('overrides, grants, report and deliveries fold; a second delivery of one ref is an anomaly', () => {
    const deliver = (seq: number) =>
      line(seq, 'message.delivered', {
        stepId: STEP,
        sessionId: SESSION,
        ref: { kind: 'message', id: CMD },
      });
    const s = fold([
      ...BASE,
      line(4, 'override.set', {
        cmdId: CMD,
        scope: 'step',
        scopeId: STEP,
        field: 'model',
        value: 'opus',
        timing: 'safe-point',
      }),
      line(5, 'grant.given', { cmdId: CMD, project: 'p', globs: ['**'], ops: ['edit'] }),
      deliver(6),
      deliver(7),
      line(8, 'report.final', {
        at: 'ready-to-publish',
        report: { sha256: 'a'.repeat(64), bytes: 1 },
      }),
    ]);
    expect(s.overrides).toEqual([
      { seq: 4, scope: 'step', scopeId: STEP, field: 'model', value: 'opus', timing: 'safe-point' },
    ]);
    expect(s.grants).toEqual([{ project: 'p', globs: ['**'], ops: ['edit'] }]);
    expect(s.deliveries).toEqual({ [CMD]: { stepId: STEP, seq: 6 } });
    expect(s.report).toEqual({ seq: 8, at: 'ready-to-publish' });
    expect(s.anomalies.map((a) => a.reason)).toEqual([`delivery ${CMD} twice`]);
  });

  it('G10 pause remembers «now» from its own command; resume clears it', () => {
    const received = (seq: number, now: boolean) =>
      line(
        seq,
        'command.received',
        {
          kind: 'pause',
          target: { taskId: TASK },
          expectSeq: null,
          fields: { now },
          proof: { token: 'core', nonce: 'absent', peer: 'clear', signature: 'absent' },
        },
        { cmdId: CMD },
      );
    const pause = line(
      5,
      'task.transition',
      { taskId: TASK, event: 'pause', from: 'running', to: 'paused' },
      { cmdId: CMD },
    );
    expect(fold([...BASE, received(4, true), pause]).pause).toEqual({ seq: 5, now: true });
    expect(fold([...BASE, received(4, false), pause]).pause).toEqual({ seq: 5, now: false });
    const resumed = fold([
      ...BASE,
      received(4, true),
      pause,
      line(6, 'task.transition', { taskId: TASK, event: 'resume', from: 'paused', to: 'running' }),
    ]);
    expect(resumed.pause).toBeNull();
  });
});
