import { describe, expect, it } from 'vitest';
import type { WindowDecision, WindowVerdict } from '@agentdeck/contracts/core/economy';
import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { windowWaitOf } from '../../api/task-view-s12.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { DEFERRABLE } from '../../economy/window/index.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { EXHAUSTED_ANSWERS } from '../next/next.types.ts';
import { presetStep } from '../scenario/presets.ts';
import { envelope, HUMAN_PROOF } from '../scenario/__fixtures__/scenario-harness.ts';
import { openAsk, ROUTE, stand, type Stand } from './__fixtures__/run-harness.ts';
import type { RunEconomy } from './run.types.ts';

/**
 * Начатая задача и окно (этап 12, P169, D19) на настоящем цикле, журнале и командах; подделаны
 * только сессия модели и книга окон. Владелец: «подождать сброса или другая модель — только по
 * клику». После первой сессии вердикт окна не уводит шаг ни на другой CLI, ни на другую модель:
 * задача входит в `waiting-window`, исчерпание спрашивает точку 7 с вариантами перевода, а
 * перевод делает только клик — ответ `cli:`/`model:` (правка с основанием — id вопроса) или
 * команда `set-cli` карточки. Первая сессия по-прежнему выбирает внутри набора (P110, соседний
 * `run.economy.test.ts`).
 */

const CODEX: JournalDataV1['task.created']['allowedRoutes'][number] = {
  adapter: 'codex',
  route: { kind: 'stub', id: 'stub-codex' },
  modelPattern: '*',
};

function verdict(routeId: string, v: WindowVerdict): WindowDecision {
  const holds = v === 'open' || v === 'warn' ? [] : [...DEFERRABLE];
  return { routeId, limitKind: 'window', verdict: v, defer: holds, resumeAt: null, reasons: [v] };
}

function book(): RunEconomy & { set(routeId: string, v: WindowVerdict | null): void } {
  const by = new Map<string, WindowDecision>();
  return {
    set(routeId, v) {
      if (v === null) by.delete(routeId);
      else by.set(routeId, verdict(routeId, v));
    },
    windows: (routeId) => {
      const d = by.get(routeId);
      return d ? [d] : [];
    },
    routingEnv: () => ({ windows: [...by.values()] }),
    recheckMs: 10,
  };
}

const WORK: Scenario = {
  id: 'started-window',
  version: 1,
  title: 't',
  steps: [presetStep('work', 'work', 'Работа', [])],
};

const lines = (s: Stand): JournalLine[] => readJournalLines(s.dir, s.taskId).lines;
const routesOpened = (s: Stand): string[] =>
  Object.values(s.task.state.sessions).map((x) => `${x.adapter}/${x.route.id}`);
const transitions = (s: Stand): string[] =>
  lines(s)
    .filter((l) => l.kind === 'task.transition')
    .map((l) => (l.data as { event: string }).event);
const tiers = (s: Stand) =>
  lines(s)
    .filter((l) => l.kind === 'decision' && (l.data as { class: string }).class === 'tier')
    .map((l) => l.data as unknown as { output: Record<string, unknown>; reasons: string[] });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Первая сессия на входе claude, потом окно этого маршрута держит; сессия снята в точке. */
async function startedThenHeld(
  v: WindowVerdict,
): Promise<{ s: Stand; econ: ReturnType<typeof book> }> {
  const econ = book();
  const s = await stand(WORK, {
    model: { 'work:0': 'hold' },
    economy: econ,
    routes: [ROUTE, CODEX],
    journalSessions: true,
  });
  await s.until(() => s.port.sessions.size === 1);
  expect(routesOpened(s)).toEqual(['claude/claude-login']);
  econ.set(ROUTE.route.id, v);
  const stepId = Object.keys(s.task.state.steps)[0]!;
  s.port.turnEnd(stepId);
  await s.until(() => s.port.ends.length === 1);
  return { s, econ };
}

describe('started task and window (stage 12, P169)', () => {
  it('refused window after the first session: no switch to the other CLI, task waits in waiting-window, resumes on the same route at reset', async () => {
    const { s, econ } = await startedThenHeld('refused');
    await s.until((t) => t.state.task === 'waiting-window');
    await pause(80);
    // Другой CLI набора годен, но окно начатой задачи маршрут не двигает.
    expect(s.port.opened).toHaveLength(1);
    expect(routesOpened(s)).toEqual(['claude/claude-login']);
    expect(Object.values(s.task.state.asks)).toHaveLength(0);
    econ.set(ROUTE.route.id, null);
    await s.until(() => s.port.opened.length === 2);
    expect(s.task.state.task).toBe('running');
    // Продолжение того же шага на том же маршруте: второй строки `session.started` нет.
    expect(s.port.opened[1]!.routing?.tier.ok && s.port.opened[1]!.routing.tier.adapter).toBe(
      'claude',
    );
    expect(transitions(s)).toEqual(['launch', 'window-wait', 'window-reset']);
    await s.stop();
  });

  it('entering waiting-window journals the refusal: the task view shows the waited route, reset time and the offers', async () => {
    const { s } = await startedThenHeld('refused');
    await s.until((t) => t.state.task === 'waiting-window');
    // Строку окна пишет проводка экономики (`bootstrap/economy-wiring/window.ts`), не исполнитель.
    s.task.append({
      kind: 'window.state',
      actor: 'core',
      data: { routeId: ROUTE.route.id, limitKind: 'window', verdict: 'refused', resetAt: 1234 },
    });
    const stepId = Object.keys(s.task.state.steps)[0]!;
    expect(windowWaitOf(s.task.state, lines(s))).toEqual({
      stepId,
      routeId: ROUTE.route.id,
      verdict: 'refused',
      resetAt: 1234,
      alternatives: ['codex/stub:stub-codex'],
      skipped: ['cli-login:claude-login=refused'],
      offers: ['cli:codex'],
      seq: expect.any(Number),
    });
    await s.stop();
  });

  it('the refusal decision of a started task names the waited route and offers the other CLI (view source)', async () => {
    const { s } = await startedThenHeld('refused');
    await s.until((t) => t.state.task === 'waiting-window');
    const { decideRouting } = await import('../scenario/index.ts');
    const rec = Object.entries(s.task.state.steps)[0]!;
    const routing = decideRouting(
      s.task.state,
      { stepId: rec[0], unitId: rec[1].unitId, def: WORK.steps[0]! },
      { windows: [verdict(ROUTE.route.id, 'refused')] },
    );
    expect(routing.tier).toMatchObject({
      ok: false,
      started: true,
      offers: ['cli:codex'],
      waits: { route: ROUTE, verdict: 'refused' },
    });
    await s.stop();
  });

  it('the card click (set-cli now) moves a waiting-window task: the next session runs on the chosen CLI with a tier line', async () => {
    const { s } = await startedThenHeld('refused');
    await s.until((t) => t.state.task === 'waiting-window');
    const got = await processCommand(
      s.task,
      envelope(s.task, 'set-cli', {
        scope: 'task',
        scopeId: s.taskId,
        adapter: 'codex',
        timing: 'now',
      }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(got).toMatchObject({ status: 'applied' });
    await s.until(() => s.port.opened.length === 2);
    expect(routesOpened(s)).toEqual(['claude/claude-login', 'codex/stub-codex']);
    expect(transitions(s)).toEqual(['launch', 'window-wait', 'window-reset']);
    const moved = tiers(s).at(-1)!;
    expect(moved.output).toMatchObject({
      adapter: 'codex',
      route: 'stub:stub-codex',
      started: true,
    });
    expect(moved.reasons).toContain('the step resumes on a route other than its last session');
    await s.stop();
  });

  it('exhausted route of a started task: point 7 although an alternative exists, options carry cli:codex; unanswered nothing switches', async () => {
    const { s } = await startedThenHeld('exhausted');
    await s.until(() => openAsk(s.task, 'exhausted:') !== undefined);
    const askId = openAsk(s.task, 'exhausted:')!;
    const asked = lines(s).find(
      (l) => l.kind === 'human.asked' && (l.data as { askId: string }).askId === askId,
    )!.data as { options: string[]; question: string };
    expect(asked.options).toEqual([EXHAUSTED_ANSWERS.wait, EXHAUSTED_ANSWERS.stop, 'cli:codex']);
    expect(asked.question).toMatch(/перевести задачу на другую модель или CLI/);
    await pause(80);
    expect(s.port.opened).toHaveLength(1);
    expect(s.task.state.overrides).toEqual([]);
    await s.stop();
  });

  it('answer «cli:codex» to point 7: an override citing the ask id, the next session runs on codex', async () => {
    const { s } = await startedThenHeld('exhausted');
    await s.until(() => openAsk(s.task, 'exhausted:') !== undefined);
    const askId = openAsk(s.task, 'exhausted:')!;
    await s.answer(askId, 'cli:codex');
    await s.until(() => s.port.opened.length === 2);
    expect(routesOpened(s)).toEqual(['claude/claude-login', 'codex/stub-codex']);
    const set = lines(s).filter((l) => l.kind === 'override.set');
    expect(set.map((l) => l.data)).toEqual([
      {
        cmdId: askId,
        scope: 'task',
        scopeId: s.taskId,
        field: 'adapter',
        value: 'codex',
        timing: 'now',
      },
    ]);
    await s.stop();
  });

  it('answer «wait» to point 7 of a started task keeps the step on its route', async () => {
    const { s } = await startedThenHeld('exhausted');
    await s.until(() => openAsk(s.task, 'exhausted:') !== undefined);
    const askId = openAsk(s.task, 'exhausted:')!;
    await s.answer(askId, EXHAUSTED_ANSWERS.wait);
    await s.until(() => s.task.state.asks[askId]?.state !== 'open');
    await pause(80);
    expect(s.port.opened).toHaveLength(1);
    expect(s.task.state.overrides).toEqual([]);
    await s.stop();
  });

  it('an answer shaped like an offer that the ask never made is refused; the ask stays open, nothing moves', async () => {
    const { s } = await startedThenHeld('exhausted');
    await s.until(() => openAsk(s.task, 'exhausted:') !== undefined);
    const askId = openAsk(s.task, 'exhausted:')!;
    await s.answer(askId, 'cli:gemini');
    const refused = lines(s).filter((l) => l.kind === 'command.rejected');
    expect(refused.map((l) => (l.data as { code: string }).code)).toEqual(['unknown-option']);
    await pause(80);
    expect(s.task.state.asks[askId]?.state).toBe('open');
    expect(s.port.opened).toHaveLength(1);
    expect(s.task.state.overrides).toEqual([]);
    await s.stop();
  });
});

/**
 * Начатая задача стоит на маршруте своей сессии, а не на «выборе без окон» (ревью этапа 12): вход
 * claude отказан уже на запуске — первая сессия честно пошла на codex. Дальше окно не двигает её ни
 * назад на claude, когда тот открылся, ни в ожидание claude, пока свой codex годен.
 */
async function launchedOnCodex(): Promise<{ s: Stand; econ: ReturnType<typeof book> }> {
  const econ = book();
  econ.set(ROUTE.route.id, 'refused');
  const s = await stand(WORK, {
    model: { 'work:0': 'hold' },
    economy: econ,
    routes: [ROUTE, CODEX],
    journalSessions: true,
  });
  await s.until(() => s.port.sessions.size === 1);
  expect(routesOpened(s)).toEqual(['codex/stub-codex']);
  return { s, econ };
}

describe('started task stays on the route of its session (stage 12 review, P169)', () => {
  it('launched on codex (claude refused at launch); codex refused, claude open — waits for codex, never moves to claude by itself', async () => {
    const { s, econ } = await launchedOnCodex();
    econ.set(ROUTE.route.id, null);
    econ.set(CODEX.route.id, 'refused');
    s.port.turnEnd(Object.keys(s.task.state.steps)[0]!);
    await s.until(() => s.port.ends.length === 1);
    await s.until((t) => t.state.task === 'waiting-window' || s.port.opened.length > 1);
    await pause(80);
    expect(routesOpened(s)).toEqual(['codex/stub-codex']);
    expect(s.port.opened).toHaveLength(1);
    expect(s.task.state.task).toBe('waiting-window');
    expect(String(tiers(s).at(-1)!.output.waits)).toContain(CODEX.route.id);
    await s.stop();
  });

  it('launched on codex; claude still refused, codex refused then reset — the step resumes on codex instead of waiting for claude', async () => {
    const { s, econ } = await launchedOnCodex();
    econ.set(CODEX.route.id, 'refused');
    s.port.turnEnd(Object.keys(s.task.state.steps)[0]!);
    await s.until(() => s.port.ends.length === 1);
    await s.until((t) => t.state.task === 'waiting-window');
    econ.set(CODEX.route.id, null);
    await s.until(() => s.port.opened.length === 2);
    const next = s.port.opened[1]!.routing?.tier;
    expect(next?.ok && next.adapter).toBe('codex');
    expect(s.task.state.task).toBe('running');
    await s.stop();
  });
});
