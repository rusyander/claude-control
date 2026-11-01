import { describe, expect, it } from 'vitest';
import type { WindowDecision, WindowVerdict } from '@agentdeck/contracts/core/economy';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { readJournalLines } from '../../journal/read-lines.ts';
import { raiseHumanPoint } from '../human/raise.ts';
import { DEFERRABLE } from '../../economy/window/index.ts';
import { presetStep } from '../scenario/presets.ts';
import { BUDGET_ANSWERS, EXHAUSTED_ANSWERS } from '../next/next.types.ts';
import { attempts, openAsk, ROUTE, stand, type Stand } from './__fixtures__/run-harness.ts';
import { KEEP_WARM_SIGNAL } from './run.ts';
import type { IdleSession, RunEconomy } from './run.types.ts';

/**
 * Экономика в цикле дирижёра (этап 5, W) на настоящем цикле и журнале; подделаны только сессия
 * модели и книга окон (вердикты — из этого стенда, судья окна — настоящий `routeWait` L): P116
 * сеть, отложение по классу шага (03:157), точка 7 исчерпанного маршрута без другого (P122),
 * подмена маршрута судьёй `tier` с записью (P110, P46), токены шага (G10), бриф сверх бюджета.
 */

const ROUTE_B: JournalDataV1['task.created']['allowedRoutes'][number] = {
  adapter: 'claude',
  route: { kind: 'stub', id: 'stub-b' },
  modelPattern: '*',
};

function verdict(
  routeId: string,
  v: WindowVerdict,
  resumeAt: number | null = null,
): WindowDecision {
  const holds = v === 'open' || v === 'warn' ? [] : [...DEFERRABLE];
  return { routeId, limitKind: 'window', verdict: v, defer: holds, resumeAt, reasons: [v] };
}

/** Книга окон стенда: вердикт по маршруту, меняется тестом. */
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

function single(kind: 'work' | 'fix', extra: Partial<Scenario['steps'][number]> = {}): Scenario {
  const step = presetStep(kind, kind, kind === 'work' ? 'Работа' : 'Фикс', []);
  return { id: `econ-${kind}`, version: 1, title: 't', steps: [{ ...step, ...extra }] };
}

const lines = (s: Stand) => readJournalLines(s.dir, s.taskId).lines;
const stepOf = (s: Stand, def: string) =>
  Object.entries(s.task.state.steps).find(([, r]) => r.stepDefId === def);

describe('conductor loop: economy (stage 5 W)', () => {
  it('P116 offline route: the live step waits for a safe point, parks soft, opens nothing while offline, resumes on recovery', async () => {
    const econ = book();
    const s = await stand(single('work'), {
      model: { 'work:0': 'hold' },
      economy: econ,
      journalSessions: true,
    });
    await s.until(() => s.port.sessions.size === 1);
    econ.set(ROUTE.route.id, 'offline');
    s.run.wake();
    // Сессия работает (ход не кончился) — безопасной точки нет, снимать нельзя.
    await new Promise((r) => setTimeout(r, 60));
    expect(s.port.ends).toEqual([]);
    const [stepId] = stepOf(s, 'work')!;
    s.port.turnEnd(stepId);
    await s.until(() => s.port.ends.length === 1);
    expect(s.port.ends[0]!.mode).toBe('soft');
    const parked = lines(s).filter(
      (l) =>
        l.kind === 'decision' && (l.data as { output: { why?: string } }).output.why === 'window',
    );
    expect(parked).toHaveLength(1);
    // Пока маршрут вне сети, шаг ждёт: новой сессии нет, хотя перепроверка идёт каждые 10 мс.
    await new Promise((r) => setTimeout(r, 80));
    expect(s.port.opened).toHaveLength(1);
    expect(s.task.state.steps[stepId]?.state).toBe('running');
    econ.set(ROUTE.route.id, null);
    await s.until(() => s.port.opened.length === 2);
    expect(s.port.opened[1]!.stepId).toBe(stepId);
    s.port.act(stepId, 'claim');
    await s.until((t) => t.state.ended !== null);
    expect(s.task.state.ended).toBe('done');
    await s.stop();
  });

  it('03:157 held window defers work but never fix: fix runs on a held route, work waits', async () => {
    const econ = book();
    econ.set(ROUTE.route.id, 'held');
    const fix = await stand(single('fix'), { economy: econ });
    await fix.until((t) => t.state.ended !== null);
    expect(fix.task.state.ended).toBe('done');
    expect(fix.port.opened).toHaveLength(1);
    await fix.stop();

    const work = await stand(single('work'), { economy: econ });
    await work.run.idle();
    expect(work.port.opened).toHaveLength(0);
    expect(work.task.state.ended).toBeNull();
    econ.set(ROUTE.route.id, 'open');
    await work.until((t) => t.state.ended !== null);
    expect(work.task.state.ended).toBe('done');
    await work.stop();
  });

  it('P122 exhausted route with no allowed alternative: point 7 once, «wait» keeps the step held until cleared, then it runs', async () => {
    const econ = book();
    econ.set(ROUTE.route.id, 'exhausted');
    const s = await stand(single('work'), { economy: econ });
    await s.until(() => openAsk(s.task, 'exhausted:') !== undefined);
    const askId = openAsk(s.task, 'exhausted:')!;
    expect(s.task.state.asks[askId]).toMatchObject({ point: 7, source: 'budget' });
    expect(s.port.opened).toHaveLength(0);
    await s.answer(askId, EXHAUSTED_ANSWERS.wait);
    await s.until(() => s.task.state.asks[askId]?.state !== 'open');
    await new Promise((r) => setTimeout(r, 60));
    // Отметку снимает только человек командой: ответ «ждать» шаг не запускает.
    expect(s.port.opened).toHaveLength(0);
    expect(
      Object.values(s.task.state.asks).filter((a) => a.dedupe?.startsWith('exhausted:')),
    ).toHaveLength(1);
    econ.set(ROUTE.route.id, null);
    await s.until((t) => t.state.ended !== null);
    expect(s.task.state.ended).toBe('done');
    await s.stop();
  });

  it('P110 + P46 exhausted route with an allowed alternative: tier substitutes, the decision names the skipped route, no point 7', async () => {
    const econ = book();
    econ.set(ROUTE.route.id, 'exhausted');
    const s = await stand(single('work'), {
      economy: econ,
      routes: [ROUTE, ROUTE_B],
      journalSessions: true,
    });
    await s.until((t) => t.state.ended !== null);
    expect(s.task.state.ended).toBe('done');
    expect(Object.values(s.task.state.asks)).toHaveLength(0);
    const started = Object.values(s.task.state.sessions);
    expect(started.map((x) => x.route.id)).toEqual(['stub-b']);
    const tier = lines(s).find(
      (l) => l.kind === 'decision' && (l.data as { class: string }).class === 'tier',
    )!.data as unknown as {
      output: { route: string; skipped: string[] };
      numbers: Record<string, number>;
    };
    expect(tier.output.route).toBe('stub:stub-b');
    expect(tier.output.skipped).toEqual(['cli-login:claude-login=exhausted']);
    expect(tier.numbers.skipped).toBe(1);
    await s.stop();
  });

  it('G10 token budget once-more: over the scenario tokens one extension, then the step stops', async () => {
    const s = await stand(single('work', { budget: { tokens: 1000 }, overBudget: 'once-more' }), {
      model: { 'work:0': 'hold' },
      journalSessions: true,
    });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = stepOf(s, 'work')!;
    // Чтение кэша — расход, но не бюджет: 5000 прочитанных токенов предел не трогают.
    s.port.usage(stepId, { input: 400, output: 500, cacheRead: 5000 });
    s.run.wake();
    await new Promise((r) => setTimeout(r, 40));
    expect(s.task.state.budgets[`tokens:step:${stepId}`]).toBeUndefined();
    s.port.usage(stepId, { input: 50, output: 100, cacheWrite: 10 });
    await s.until(() => s.task.state.budgets[`tokens:step:${stepId}`] !== undefined);
    expect(s.task.state.budgets[`tokens:step:${stepId}`]).toMatchObject({
      limit: 2000,
      spent: 1060,
    });
    expect(s.task.state.steps[stepId]?.state).toBe('running');
    s.port.usage(stepId, { input: 1000, output: 0 });
    await s.until((t) => t.state.ended !== null);
    expect(s.task.state.steps[stepId]?.reason).toMatch(/^budget: spent 2060 of 2000 tokens/);
    await s.stop();
  });

  it('G10 token budget ask: point 7 by its own key, «extend» doubles the limit', async () => {
    const s = await stand(single('work', { budget: { tokens: 100 }, overBudget: 'ask' }), {
      model: { 'work:0': 'hold' },
      journalSessions: true,
    });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = stepOf(s, 'work')!;
    s.port.usage(stepId, { input: 90, output: 20 });
    await s.until(() => openAsk(s.task, 'budget-tokens:') !== undefined);
    const askId = openAsk(s.task, `budget-tokens:${stepId}:100`)!;
    expect(s.task.state.asks[askId]?.point).toBe(7);
    await s.answer(askId, BUDGET_ANSWERS.more);
    await s.until(() => s.task.state.budgets[`tokens:step:${stepId}`]?.limit === 200);
    expect(s.task.state.steps[stepId]?.state).toBe('running');
    await s.stop();
  });

  it('03:136 brief over budget: the step fails naming the bins, no session is opened', async () => {
    const econ: RunEconomy = {
      windows: () => [],
      briefRefusal: () => 'work: task 9000 > 4000',
    };
    const s = await stand(single('work'), { economy: econ });
    await s.until((t) => t.state.ended !== null);
    expect(s.port.opened).toHaveLength(0);
    const [, rec] = stepOf(s, 'work')!;
    expect(rec.reason).toBe('brief-over-budget: work: task 9000 > 4000');
    expect(s.task.state.ended).toBe('failed');
    await s.stop();
  });

  it('G8 keep-warm execution: the economy port picks idle sessions, the loop sends its word once, journals the numbers, a session mid-ping is not offered again', async () => {
    const seen: IdleSession[][] = [];
    const econ: RunEconomy = {
      windows: () => [],
      keepWarmTickMs: 10,
      keepWarm: (_t, idle) => {
        seen.push([...idle]);
        return idle.map((i) => ({
          sessionId: i.sessionId,
          word: 'WARM',
          reasons: ['cache age 50 of 60 min'],
          numbers: { ageMs: 3_000_000 },
        }));
      },
    };
    const s = await stand(single('work'), { model: { 'work:0': 'hold' }, economy: econ });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = stepOf(s, 'work')!;
    const [sessionId, sess] = [...s.port.sessions.entries()][0]!;
    // Сессия работает: в конце хода её нет — греть нечего.
    await new Promise((r) => setTimeout(r, 40));
    expect(sess.sends.filter((x) => x.text === 'WARM')).toHaveLength(0);
    // Шаг ждёт человека (вопрос права), сессия в конце хода — стоит не по своей воле.
    const asked = raiseHumanPoint(s.task, {
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
    }) as { askId: string };
    s.port.turnEnd(stepId);
    await s.until(() => sess.sends.some((x) => x.text === 'WARM'));
    // Пока идёт ход пинга, сессия не «в конце хода»: второго пинга нет.
    await new Promise((r) => setTimeout(r, 60));
    const warm = sess.sends.filter((x) => x.text === 'WARM');
    expect(warm).toHaveLength(1);
    expect(warm[0]!.cmdId).toMatch(new RegExp(`^keep-warm:${sessionId}:\\d+$`));
    expect(warm[0]!.origin).toBe('platform');
    expect(seen.flat().every((i) => i.sessionId === sessionId && i.parked && i.turnSeq > 0)).toBe(
      true,
    );
    const signal = lines(s).find(
      (l) => l.kind === 'signal' && (l.data as { signal: string }).signal === KEEP_WARM_SIGNAL,
    )!.data as { subject: string; detail: string };
    expect(signal.subject).toBe(sessionId);
    expect(JSON.parse(signal.detail)).toEqual({
      reasons: ['cache age 50 of 60 min'],
      numbers: { ageMs: 3_000_000 },
    });
    // Конец хода пинга — не конец хода шага: ожидание то же (тот же `turnSeq`), шаг стоит, где стоял.
    const offered = seen.length;
    s.port.turnEnd(stepId);
    await s.until(() => seen.length > offered);
    const waits = new Set(seen.flat().map((i) => i.turnSeq));
    expect(waits.size).toBe(1);
    expect(s.task.state.steps[stepId]?.state).not.toBe('ended');
    // Ответ человека, затем модель заявляет шаг — он кончается как обычно.
    await s.answer(asked.askId, 'нет');
    s.port.act(stepId, 'claim');
    await s.until((t) => t.state.ended !== null);
    expect(s.task.state.ended).toBe('done');
    await s.stop();
  });

  it('continuation consumption: the opening (brief or delta) of the economy port is what the session gets; null → the step line', async () => {
    const seen: string[] = [];
    const econ: RunEconomy = {
      windows: () => [],
      opening: (_t, s, sessionId) => {
        seen.push(sessionId);
        return s.round === 0 ? 'BRIEF-FROM-C' : null;
      },
    };
    const s = await stand(
      { id: 'two', version: 1, title: 't', steps: [presetStep('work', 'work', 'Работа', [])] },
      { economy: econ, post: { 'work:0': 'red' } },
    );
    await s.until((t) => t.state.ended !== null);
    const sends = [...s.port.sessions.values()].map((x) => x.sends[0]?.text);
    expect(sends[0]).toBe('BRIEF-FROM-C');
    expect(sends[1]).toMatch(/^Step «Работа» \(work\), stepId .*, round 1\./);
    expect(seen).toEqual([...s.port.sessions.keys()]);
    expect(attempts(s.task).at(-1)).toBe('work:1:done:claimed');
    await s.stop();
  });
});
