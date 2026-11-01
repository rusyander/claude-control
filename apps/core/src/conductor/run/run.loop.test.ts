import { describe, expect, it } from 'vitest';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { foldJournal } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { applyPause } from '../commands/pause.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { applyResume } from '../commands/resume.ts';
import { raiseHumanPoint } from '../human/raise.ts';
import { decideNext } from '../next/next.ts';
import { BUDGET_ANSWERS } from '../next/next.types.ts';
import { presetStep } from '../scenario/presets.ts';
import { attempts, openAsk, stand, type Stand } from './__fixtures__/run-harness.ts';

/**
 * Цикл дирижёра на границах шага: напоминания (P16), срок шага (точка 7), стоп-сигнал по шагу
 * (защищённые корни, F-061), пауза в безопасной точке и продолжение (G10, P11), перезапуск ядра.
 */

const FEATURE = { id: 'feature', version: 1 };
const ONE_MIN = 60_000;

function oneStep(overBudget: 'stop' | 'ask' | 'once-more'): Scenario {
  const work = presetStep('work', 'work', 'Работа', []);
  return {
    id: `budget-${overBudget}`,
    version: 1,
    title: 't',
    steps: [{ ...work, budget: { minutes: 1 }, overBudget }],
  };
}

const workStep = (s: Stand) =>
  Object.entries(s.task.state.steps).find(([, r]) => r.stepDefId === 'work');
const lines = (s: Stand) => readJournalLines(s.dir, s.taskId).lines;

async function command(s: Stand, kind: 'pause' | 'resume', fields: Record<string, unknown>) {
  const cmdId = newId();
  s.task.append({
    kind: 'command.received',
    actor: 'human:panel',
    cmdId,
    data: {
      kind,
      target: { taskId: s.taskId },
      expectSeq: null,
      fields,
      proof: { token: 'core', nonce: 'absent', peer: 'clear', signature: 'absent' },
    } as never,
  });
  const env = { cmdId, kind, target: { taskId: s.taskId }, expectSeq: null, fields };
  await (kind === 'pause' ? applyPause : applyResume)(
    s.task,
    env as unknown as CommandEnvelope,
    commandEnv(),
  );
}

describe('conductor loop: turn ends, budget, stops, pause', () => {
  it('P16 no step_done: one reminder per turn end, three per step, then failed(no-outcome), one retry, then point 6', async () => {
    const s = await stand(FEATURE, { model: { 'work:0': 'silent', 'work:1': 'silent' } });
    await s.run.idle();
    const work = Object.values(s.task.state.steps).filter((r) => r.stepDefId === 'work');
    expect(work.map((r) => [r.round, r.state, r.reminders, new Set(r.remindedTurns).size])).toEqual(
      [
        [0, 'failed', 3, 3],
        [1, 'failed', 3, 3],
      ],
    );
    expect(work.map((r) => r.reason)).toEqual([
      'no-outcome: no edits, no step_done',
      'no-outcome: no edits, no step_done',
    ]);
    const reminded = lines(s).filter((l) => l.kind === 'step.reminded');
    expect(reminded).toHaveLength(6);
    expect(s.task.state.anomalies).toEqual([]);
    const ask = openAsk(s.task, 'round-cap:');
    expect(s.task.state.asks[ask!]).toMatchObject({ point: 6, source: 'round-cap' });
    await s.stop();
  });

  it('P16 derived outcome: edits after three reminders → done(derived), the task goes on', async () => {
    const s = await stand(FEATURE, { model: { 'work:0': 'silent' }, post: { 'work:0': 'edits' } });
    await s.run.idle();
    expect(attempts(s.task)[2]).toBe('work:0:done:derived');
    expect(workStep(s)?.[1].reminders).toBe(3);
    expect(s.calls).toContain('post:work:0:none');
    await s.stop();
  });

  it('budget stop: over the step budget the session tree is stopped and the step fails', async () => {
    const s = await stand(oneStep('stop'), { model: { 'work:0': 'hold' } });
    await s.until((t) => Object.values(t.state.steps).some((r) => r.state === 'running'));
    await s.until(() => s.port.sessions.size === 1);
    s.clock.advance(ONE_MIN + 1);
    s.run.wake();
    await s.until((t) => t.state.ended !== null);
    expect(workStep(s)?.[1].reason).toMatch(/^budget: spent \d+ of 60000 ms/);
    expect(s.port.ends.map((e) => e.mode)).toEqual(['tree']);
    expect(s.task.state.ended).toBe('failed');
    await s.stop();
  });

  it('budget once-more: one extension, then stop', async () => {
    const s = await stand(oneStep('once-more'), { model: { 'work:0': 'hold' } });
    await s.until(() => s.port.sessions.size === 1);
    s.clock.advance(ONE_MIN + 1);
    s.run.wake();
    await s.until(() => workStep(s)?.[1].extensions === 1);
    expect(workStep(s)?.[1]).toMatchObject({ budgetMs: 2 * ONE_MIN, state: 'running' });
    s.clock.advance(ONE_MIN);
    s.run.wake();
    await s.until((t) => t.state.ended === 'failed');
    await s.stop();
  });

  it('budget ask: point 7 once per budget; «extend» answer extends and the step runs on', async () => {
    const s = await stand(oneStep('ask'), { model: { 'work:0': 'hold' } });
    await s.until(() => s.port.sessions.size === 1);
    s.clock.advance(ONE_MIN + 1);
    s.run.wake();
    await s.until((t) => openAsk(t, 'budget:') !== undefined);
    const ask = openAsk(s.task, 'budget:')!;
    expect(s.task.state.asks[ask]).toMatchObject({ point: 7, source: 'budget' });
    expect(workStep(s)?.[1].state).toBe('waiting-human');
    s.run.wake();
    await s.answer(ask, BUDGET_ANSWERS.more);
    await s.until(() => workStep(s)?.[1].extensions === 1);
    expect(workStep(s)?.[1]).toMatchObject({ state: 'running', budgetMs: 2 * ONE_MIN });
    expect(Object.keys(s.task.state.asks)).toHaveLength(1);
    await s.stop();
  });

  it('F-061 protected root: a stop signal on the step stops it, closes the unit, fails the task', async () => {
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' } });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = Object.keys(s.task.state.steps);
    s.task.append({
      kind: 'signal',
      actor: 'core',
      stepId: stepId!,
      data: { signal: 'protected-root', severity: 'stop', subject: '/main', detail: 'head moved' },
    });
    await s.until((t) => t.state.ended !== null);
    expect(s.task.state.steps[stepId!]).toMatchObject({
      state: 'failed',
      reason: 'stopped: protected-root: /main',
    });
    expect(s.port.ends).toEqual([{ sessionId: expect.any(String), mode: 'tree' }]);
    expect(Object.values(s.task.state.units)[0]?.state).toBe('closed');
    expect(s.task.state.ended).toBe('failed');
    await s.stop();
  });

  it('G10 pause waits for the safe point, parks soft; resume relaunches; P11 the live fold equals a fresh replay', async () => {
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' } });
    await s.until(() => s.port.sessions.size === 1);
    s.port.toolOpen(Object.keys(s.task.state.steps)[0]!, 1);
    await command(s, 'pause', { now: false });
    await s.until((t) => t.state.task === 'paused');
    s.run.wake();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.port.ends).toEqual([]); // середина хода — не безопасная точка
    const [stepId] = Object.keys(s.task.state.steps);
    s.port.turnEnd(stepId!);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.port.ends).toEqual([]); // ход кончился, но инструмент без результата
    s.port.toolOpen(stepId!, -1);
    await s.until(() => s.port.ends.length === 1);
    expect(s.port.ends[0]?.mode).toBe('soft');
    await command(s, 'resume', {});
    await s.until(() => s.port.sessions.size === 2);
    expect(s.task.state.steps[stepId!]?.state).toBe('running');
    const replay = foldJournal(s.dir, s.taskId).state;
    expect(replay).toEqual(s.task.state);
    const scenario = { ...(await import('../scenario/presets.ts')).presetOf(FEATURE)! };
    const input = { scenario, workNowMs: 0, live: {} };
    expect(decideNext({ ...input, state: replay })).toEqual(
      decideNext({ ...input, state: s.task.state }),
    );
    await s.stop();
  });

  it('G10 pause now: the tree is stopped at once, without waiting for a safe point', async () => {
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' } });
    await s.until(() => s.port.sessions.size === 1);
    s.port.toolOpen(Object.keys(s.task.state.steps)[0]!, 1);
    await command(s, 'pause', { now: true });
    await s.until(() => s.port.ends.length === 1);
    expect(s.port.ends[0]?.mode).toBe('tree');
    expect(s.task.state.pause).toMatchObject({ now: true });
    await s.stop();
  });

  it('core restart mid-step: the next core reattaches the same session, the brief is not sent twice', async () => {
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' } });
    await s.until(() => s.port.sessions.size === 1);
    const [sessionId] = [...s.port.sessions.keys()];
    s.port.reattach = sessionId!;
    await s.restart();
    await s.until(
      (t) => lines(s).filter((l) => l.kind === 'decision').length > 0 && t.state.seq > 0,
    );
    await s.until(() => s.port.reattach === null);
    expect(s.port.sessions.size).toBe(1);
    expect(s.port.sessions.get(sessionId!)?.sends).toHaveLength(1);
    const [stepId] = Object.keys(s.task.state.steps);
    s.port.act(stepId!, 'claim');
    await s.run.idle();
    expect(attempts(s.task)[0]).toBe('intake:0:done:claimed');
    expect(Object.values(s.task.state.units)[0]?.state).toBe('done');
    // Маршрут шага записан один раз — на первом запуске; новое ядро судит его заново без строки.
    const opened = s.port.opened;
    expect(opened.slice(0, 2).map((o) => o.stepId)).toEqual([stepId, stepId]);
    expect(decisions(s, 'tier')).toHaveLength(new Set(opened.map((o) => o.stepId)).size);
    expect(opened.length).toBe(decisions(s, 'tier').length + 1);
    expect(opened.every((o) => o.routing?.tier.ok === true)).toBe(true);
    await s.stop();
  });
});

const decisions = (s: Stand, cls: string) =>
  lines(s).filter((l) => l.kind === 'decision' && (l.data as { class: string }).class === cls);

/** Блокирующий вопрос по шагу от сессии (вопрос права, точка 3) — шаг ждёт человека. */
function blocker(s: Stand, stepId: string) {
  const sessionId = [...s.port.sessions.keys()][0]!;
  const got = raiseHumanPoint(s.task, {
    source: 'permit',
    stepId,
    sessionId,
    action: null,
    point: 3,
    dedupe: `permit:${stepId}`,
    question: 'Сливать?',
    options: ['да', 'нет'],
    recommendation: 'нет',
    blocking: true,
  });
  expect(got).toMatchObject({ kind: 'asked', waiting: true });
  return { sessionId, askId: (got as { askId: string }).askId };
}

describe('conductor loop: the human word reaches a live session (zone E seam)', () => {
  it('an answer to a session idle at its turn end is sent at once, recorded after the send, no reminder', async () => {
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' } });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = Object.keys(s.task.state.steps);
    const { sessionId, askId } = blocker(s, stepId!);
    s.port.turnEnd(stepId!);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.task.state.steps[stepId!]?.state).toBe('waiting-human');
    await s.answer(askId, 'нет');
    await s.until(() => Object.keys(s.task.state.deliveries).length === 1);
    const sends = s.port.sessions.get(sessionId)!.sends;
    expect(sends).toHaveLength(2);
    expect(sends[1]!.text).toContain('The human answered «Сливать?»');
    // P37: бриф — голос платформы, ответ человека — с его строкой.
    expect(sends.map((x) => x.origin)).toEqual(['platform', 'human']);
    const [ref] = Object.keys(s.task.state.deliveries);
    expect(sends[1]!.cmdId).toBe(ref);
    expect(s.task.state.deliveries[ref!]).toMatchObject({ stepId });
    // Строка доставки идёт после отправки и одна: повтор цикла её не дублирует.
    await new Promise((r) => setTimeout(r, 30));
    expect(lines(s).filter((l) => l.kind === 'message.delivered')).toHaveLength(1);
    expect(lines(s).filter((l) => l.kind === 'step.reminded')).toEqual([]);
    expect(s.task.state.steps[stepId!]?.state).toBe('running');
    await s.stop();
  });

  it('an open ask gets its reminder from the loop tick while nothing else happens (upkeep)', async () => {
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' }, upkeepEveryMs: 5 });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = Object.keys(s.task.state.steps);
    const { askId } = blocker(s, stepId!);
    await new Promise((r) => setTimeout(r, 30));
    const reminders = () =>
      lines(s).filter(
        (l) => l.kind === 'signal' && (l.data as { subject: string }).subject === askId,
      );
    expect(reminders()).toEqual([]);
    s.clock.advance(15 * ONE_MIN + 1);
    await s.until(() => reminders().length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(reminders()).toHaveLength(1);
    await s.stop();
  });
});

describe('conductor loop: step routing (zone A routeStep)', () => {
  it('each model step is routed once at its start; the session gets the tier, core steps none', async () => {
    const s = await stand(FEATURE);
    await s.run.idle();
    const model = ['intake', 'plan', 'work', 'review'];
    expect(s.port.opened.map((o) => o.def.id)).toEqual(model);
    expect(s.port.opened.map((o) => o.routing?.tier)).toEqual(
      model.map(() => expect.objectContaining({ ok: true, adapter: 'claude' })),
    );
    expect(decisions(s, 'tier')).toHaveLength(model.length);
    expect(decisions(s, 'continuation')).toHaveLength(model.length);
    await s.stop();
  });

  it('no allowed route: the step fails no-route before any session, the task fails', async () => {
    const s = await stand(FEATURE, { routes: [] });
    await s.until((t) => t.state.ended !== null);
    expect(s.port.opened).toEqual([]);
    expect(attempts(s.task)[0]).toBe('intake:0:failed:core');
    expect(workStep(s)).toBeUndefined();
    const [rec] = Object.values(s.task.state.steps);
    expect(rec?.reason).toMatch(/^no-route: .*no allowed route/);
    expect(s.task.state.ended).toBe('failed');
    await s.stop();
  });
});
