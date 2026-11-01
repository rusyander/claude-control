import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { createRunEconomy } from '../../bootstrap/economy-wiring/continuation.ts';
import { attachObserver } from '../../bootstrap/observer-wiring/attach.ts';
import type { ContinuationFacts } from '../../economy/continuation.types.ts';
import { DEFERRABLE, WindowBook } from '../../economy/window/index.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { presetStep } from '../scenario/presets.ts';
import { ROUTE, stand, type Stand } from './__fixtures__/run-harness.ts';
import type { RunEconomy } from './run.types.ts';

/**
 * Пауза по сигналу наблюдателя (этап 8, F10) на настоящем цикле дирижёра, свёртке и наблюдателе:
 * рост контекста главной сессии выше 60 % окна → `context-growth` (pause-at-safe-point) → сессию
 * паркуют мягко на конце хода → повтор шага открывает новую сессию и пишет `continuation` с
 * числами. Подделаны только сессия модели и числа продолжения.
 */

const WINDOW = 200_000;

function single(): Scenario {
  const step = presetStep('work', 'work', 'Работа', []);
  return { id: 'observer-park', version: 1, title: 't', steps: [step] };
}

/** Числа продолжения: контекст последнего хода сессии против окна маршрута. */
function economy(contextTokens: () => number, offline: () => boolean = () => false): RunEconomy {
  const win = (routeId: string): WindowDecision[] =>
    offline()
      ? [
          {
            routeId,
            limitKind: 'window',
            verdict: 'offline',
            defer: [...DEFERRABLE],
            resumeAt: null,
            reasons: ['offline'],
          },
        ]
      : [];
  return {
    windows: win,
    recheckMs: 10,
    routingEnv: () => ({
      windows: win(ROUTE.route.id),
      continuation: () => ({
        transcriptPresent: true,
        facts: {
          now: 1_000,
          lastTurnAt: 900,
          contextTokens: contextTokens(),
          cacheTtlMs: 300_000,
          windowTokens: WINDOW,
          baseTokens: 10_000,
          briefTokens: 1_000,
          expectedTurns: 5,
          orientationTurns: 1,
        } satisfies ContinuationFacts,
      }),
    }),
  };
}

const lines = (s: Stand): JournalLine[] => readJournalLines(s.dir, s.taskId).lines;
const decisions = (s: Stand, cls: string) =>
  lines(s).filter((l) => l.kind === 'decision' && (l.data as { class: string }).class === cls);
const workStep = (s: Stand) =>
  Object.entries(s.task.state.steps).find(([, r]) => r.stepDefId === 'work')![0];

async function ramp(context: number) {
  let last = 0;
  const s = await stand(single(), {
    model: { 'work:0': 'hold' },
    journalSessions: true,
    economy: economy(() => last),
  });
  const observer = attachObserver(s.task, { ctx: { windowOf: () => WINDOW, now: () => 0 } });
  await s.until(() => s.port.sessions.size === 1);
  const stepId = workStep(s);
  last = context;
  s.port.usage(stepId, { input: context * 0.1, cacheRead: context * 0.9, output: 100 });
  return { s, stepId, observer };
}

describe('observer park: context growth parks at a safe point and the re-run journals continuation', () => {
  it('65 % of the window → context-growth, soft park at the turn end, a new session, a second continuation row with numbers', async () => {
    const { s, stepId, observer } = await ramp(130_000);
    await s.until(() => s.task.state.sessions[[...s.port.sessions.keys()][0]!]?.parkAsked != null);
    // Ход не кончился — безопасной точки нет, сессия живёт.
    await new Promise((r) => setTimeout(r, 40));
    expect(s.port.ends).toEqual([]);
    s.port.turnEnd(stepId);
    await s.until(() => s.port.opened.length === 2);
    expect(s.port.ends).toEqual([{ sessionId: [...s.port.sessions.keys()][0], mode: 'soft' }]);
    const cont = decisions(s, 'continuation');
    expect(cont).toHaveLength(2);
    const second = cont[1]!.data as unknown as {
      output: { mode: string; reason?: string };
      numbers: Record<string, number>;
      reasons: string[];
    };
    expect(second.output.mode).toBe('fresh');
    expect(second.numbers['contextTokens']).toBe(130_000);
    expect(second.reasons.at(-1)).toMatch(/^observer park:/);
    // Маршрут тот же — второй строки `tier` нет.
    expect(decisions(s, 'tier')).toHaveLength(1);
    const signal = lines(s).find(
      (l) => l.kind === 'signal' && (l.data as { signal: string }).signal === 'context-growth',
    );
    expect(signal?.data).toMatchObject({ severity: 'warn', action: 'pause-at-safe-point' });
    observer.detach();
    await s.stop();
  });

  it('DEFECT 1: a core restart between the park ask and the safe point keeps the park — the re-run still journals continuation with the observer reason', async () => {
    const { s, observer } = await ramp(130_000);
    const [first] = [...s.port.sessions.keys()];
    await s.until(() => s.task.state.sessions[first!]?.parkAsked != null);
    observer.detach();
    // Новое ядро: хост сессии не пережил перезапуск — сверка загрузки пишет lost до исполнителя.
    await s.restart((task) => {
      task.append({
        kind: 'session.transition',
        actor: 'core',
        sessionId: first!,
        data: { sessionId: first!, event: 'host-dead', from: 'live', to: 'lost' },
      });
    });
    await s.until(() => s.port.opened.length === 2);
    const cont = decisions(s, 'continuation');
    expect(cont).toHaveLength(2);
    const second = cont[1]!.data as unknown as { output: { mode: string }; reasons: string[] };
    expect(second.output.mode).toBe('fresh');
    expect(second.reasons.at(-1)).toMatch(/^observer park:/);
    await s.stop();
  });

  it('near-miss: 55 % of the window raises nothing; the turn end is reminded, the session is never parked', async () => {
    const { s, stepId, observer } = await ramp(110_000);
    s.port.turnEnd(stepId);
    await s.until(() => s.task.state.steps[stepId]!.reminders === 1);
    expect(s.port.ends).toEqual([]);
    expect(s.port.opened).toHaveLength(1);
    expect(decisions(s, 'continuation')).toHaveLength(1);
    expect(lines(s).some((l) => l.kind === 'signal')).toBe(false);
    observer.detach();
    await s.stop();
  });

  it('a park for another reason (offline window) keeps one continuation row per step on the re-run', async () => {
    let offline = false;
    const s = await stand(single(), {
      model: { 'work:0': 'hold' },
      journalSessions: true,
      economy: economy(
        () => 1_000,
        () => offline,
      ),
    });
    await s.until(() => s.port.sessions.size === 1);
    const stepId = workStep(s);
    offline = true;
    s.run.wake();
    s.port.turnEnd(stepId);
    await s.until(() => s.port.ends.length === 1);
    offline = false;
    s.run.wake();
    await s.until(() => s.port.opened.length === 2);
    expect(decisions(s, 'continuation')).toHaveLength(1);
    await s.stop();
  });
});

/**
 * Маршрут по входу CLI (подписка): окна в настройках маршрута нет (`route-windows` → `null`), окно
 * назвала сама сессия (`turn.usage.contextWindow`). Числа продолжения — настоящие
 * (`createRunEconomy` из журнала), не подделка.
 */
async function rampReported(context: number) {
  const s = await stand(single(), {
    model: { 'work:0': 'hold' },
    journalSessions: true,
    economy: createRunEconomy({ windows: new WindowBook(), now: Date.now, windowOf: () => null }),
  });
  const observer = attachObserver(s.task, { ctx: { windowOf: () => null, now: () => 0 } });
  await s.until(() => s.port.sessions.size === 1);
  const stepId = workStep(s);
  s.port.usage(stepId, {
    input: context * 0.1,
    cacheRead: context * 0.9,
    output: 100,
    contextWindow: WINDOW,
  });
  return { s, stepId, observer };
}

describe('observer park on a cli-login route: the window is the one the session reported', () => {
  it('65 % of the reported window → context-growth, soft park at the turn end, a fresh session with continuation numbers from the journal', async () => {
    const { s, stepId, observer } = await rampReported(130_000);
    const [first] = [...s.port.sessions.keys()];
    await s.until(() => s.task.state.sessions[first!]?.parkAsked != null);
    s.port.turnEnd(stepId);
    await s.until(() => s.port.opened.length === 2);
    expect(s.port.ends).toEqual([{ sessionId: first, mode: 'soft' }]);
    const signal = lines(s).find(
      (l) => l.kind === 'signal' && (l.data as { signal: string }).signal === 'context-growth',
    );
    expect(signal?.data).toMatchObject({ severity: 'warn', action: 'pause-at-safe-point' });
    const cont = decisions(s, 'continuation');
    expect(cont).toHaveLength(2);
    const second = cont[1]!.data as unknown as {
      output: { mode: string };
      numbers: Record<string, number>;
      reasons: string[];
    };
    expect(second.output.mode).toBe('fresh');
    expect(second.numbers['contextTokens']).toBe(130_000);
    expect(second.numbers['windowTokens']).toBe(WINDOW);
    expect(second.reasons.at(-1)).toMatch(/^observer park:/);
    observer.detach();
    await s.stop();
  });

  it('near-miss: 55 % of the reported window raises nothing and the session is never parked', async () => {
    const { s, stepId, observer } = await rampReported(110_000);
    s.port.turnEnd(stepId);
    await s.until(() => s.task.state.steps[stepId]!.reminders === 1);
    expect(s.port.ends).toEqual([]);
    expect(s.port.opened).toHaveLength(1);
    expect(lines(s).some((l) => l.kind === 'signal')).toBe(false);
    observer.detach();
    await s.stop();
  });
});
