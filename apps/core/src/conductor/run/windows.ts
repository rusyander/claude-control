import type { Scenario } from '@agentdeck/contracts/core/scenario';
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
 * набора; отказ `tier` из-за окна — первый пропущенный маршрут (ждать его, а не проваливать шаг).
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
      (tier.ok ? tier.route.id : (tier.skipped[0]?.route.route.id ?? null));
    if (!routeId) continue;
    out[stepId] = {
      routeId,
      decisions: economy.windows(routeId),
      alternatives: tier.ok ? tier.alternatives.length : 0,
    };
  }
  return out;
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
