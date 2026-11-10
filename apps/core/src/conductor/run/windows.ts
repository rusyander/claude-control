import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { tierDecisionBody } from '../../economy/records.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { isCoreKind } from '../next/active.ts';
import type { StepWindow } from '../next/next.types.ts';
import { windowGate } from '../next/window.ts';
import { decideRouting } from '../scenario/index.ts';
import type { RunEconomy } from './run.types.ts';

/**
 * Окно маршрута каждой идущей попытки шага модели (этап 5, W) — вход суда `next`. Маршрут попытки:
 * открытой сессии шага (она уже идёт по нему), иначе тот, куда её поведёт суд `tier` с окнами
 * набора; отказ `tier` из-за окна — маршрут, который ждёт начатая задача (P169), иначе первый
 * пропущенный маршрут (ждать его, а не проваливать шаг).
 */

const OPEN = new Set(['starting', 'live', 'quiet']);

function sessionRoute(state: TaskFoldState, stepId: string): string | null {
  let best: { seq: number; id: string } | null = null;
  for (const s of Object.values(state.sessions)) {
    if (s.stepId !== stepId || !OPEN.has(s.state)) continue;
    const seq = state.steps[stepId]?.startedSeq ?? 0;
    if (!best || seq >= best.seq) best = { seq, id: s.route.id };
  }
  return best?.id ?? null;
}

export function stepWindows(
  task: LiveTask,
  scenario: Scenario,
  economy: RunEconomy,
): Record<string, StepWindow> {
  const { state } = task;
  const out: Record<string, StepWindow> = {};
  const env = economy.routingEnv?.(task) ?? {};
  for (const [stepId, rec] of Object.entries(state.steps)) {
    if (rec.outcome !== undefined) continue;
    if (rec.state !== 'queued' && rec.state !== 'running') continue;
    const def = scenario.steps.find((d) => d.id === rec.stepDefId);
    if (!def || isCoreKind(def)) continue;
    const routing = decideRouting(state, { stepId, unitId: rec.unitId, def }, env);
    const { tier } = routing;
    const routeId =
      sessionRoute(state, stepId) ??
      (tier.ok
        ? tier.route.id
        : (tier.waits?.route.route.id ?? tier.skipped[0]?.route.route.id ?? null));
    if (!routeId) continue;
    out[stepId] = {
      routeId,
      decisions: economy.windows(routeId),
      // Начатая задача (P169): годные маршруты — не уход, а только варианты клика человека.
      offers: tier.ok ? [] : [...(tier.offers ?? [])],
    };
  }
  return out;
}

/**
 * Строка `tier` на входе в `waiting-window` (этап 12): отказ суда с ждущим маршрутом и вариантами
 * клика — экран задачи берёт их из последней строки `tier` (`api/task-view-s12.ts`), а прежняя
 * строка — выбор первой сессии, в ней нет ни ожидания, ни вариантов. Суд выбрал маршрут (шаг ждёт
 * окно живой сессии) — строки нет.
 */
export function journalWaitTier(
  task: LiveTask,
  scenario: Scenario,
  economy: RunEconomy | undefined,
  stepId: string,
): void {
  const rec = task.state.steps[stepId];
  const def = rec ? scenario.steps.find((d) => d.id === rec.stepDefId) : undefined;
  if (!rec || !def) return;
  const { tier } = decideRouting(
    task.state,
    { stepId, unitId: rec.unitId, def },
    economy?.routingEnv?.(task) ?? {},
  );
  if (tier.ok) return;
  const body = tierDecisionBody(tier);
  // Без конверта `stepId`/`unitId`: по ним строку `tier` читают ступень попытки (эскалация,
  // выученное) и снятие метки паузы наблюдателя — отказ ожидания не попытка. Шаг — в выходе.
  task.append({
    kind: 'decision',
    actor: 'core',
    data: {
      decisionId: newId(),
      ...body,
      output: { ...(body.output as Record<string, unknown>), stepId } as never,
    },
  });
}

/**
 * Когда перепроверить окно: ближайший сброс держащих маршрутов, а без срока (сеть, исчерпание)
 * — через `recheckMs`. `null` — никто не ждёт окна.
 */
export function windowWakeMs(
  windows: Readonly<Record<string, StepWindow>>,
  scenario: Scenario,
  state: TaskFoldState,
  now: number,
  recheckMs: number,
): number | null {
  let wake: number | null = null;
  for (const [stepId, w] of Object.entries(windows)) {
    const def = scenario.steps.find((d) => d.id === state.steps[stepId]?.stepDefId);
    if (!def) continue;
    const gate = windowGate(w, def);
    if (!gate) continue;
    const ms = gate.resumeAt === null ? recheckMs : Math.max(1, gate.resumeAt - now + 1);
    wake = wake === null ? ms : Math.min(wake, ms);
  }
  return wake;
}
