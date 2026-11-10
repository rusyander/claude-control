import type { BoardStop } from '@agentdeck/contracts/core/board';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { TaskFoldState, UsageTotals } from './reduce.types.ts';
import { ZERO_USAGE } from './stage5.ts';

/**
 * Чтение полей свёртки v7 (план s5 §3) для судей экономики и проводки: потребители не знают
 * ключей словарей свёртки. Чистые функции над состоянием; свёртку не импортируют
 * (`core-reduce-only-via-resume`).
 */

/** Область расхода — та же запись, что у `budget.state.scope`: `task`, `step:<id>`, `session:<id>`. */
export type UsageScope = 'task' | 'subagents' | `step:${string}` | `session:${string}`;

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function usageOf(state: TaskFoldState, scope: UsageScope): UsageTotals {
  if (scope === 'task') return state.usage.task;
  if (scope === 'subagents') return state.usage.subagents;
  if (scope.startsWith('step:')) return own(state.usage.byStep, scope.slice(5)) ?? ZERO_USAGE;
  return own(state.usage.bySession, scope.slice(8)) ?? ZERO_USAGE;
}

export type WindowRow = JournalDataV1['window.state'] & { seq: number };

/** Последние вердикты маршрута по каждому виду предела (пусто — фактов окна в задаче не было). */
export function windowOf(state: TaskFoldState, routeId: string): WindowRow[] {
  return Object.values(state.windows).filter((w) => w.routeId === routeId);
}

/**
 * Разрешённый набор маршрутов задачи сейчас: последний `routes.set` (команда человека) поверх
 * набора `task.created`. Читать набор иначе — пропустить расширение или сужение командой.
 */
export function allowedRoutesOf(
  state: TaskFoldState,
): JournalDataV1['task.created']['allowedRoutes'] {
  return state.routesSet?.allowedRoutes ?? state.created?.allowedRoutes ?? [];
}

/**
 * Этап 12 (P157): где задача остановится — последний `task.stop` поверх записи доски
 * `task.created.boardEntry`. `null` — задача не с доски и остановку не меняли: поведение — по
 * настройке репозитория.
 */
export function boardStopOf(state: TaskFoldState): BoardStop | null {
  return state.stop?.stop ?? state.created?.boardEntry?.stop ?? null;
}

/** Этап 12: открытый перехват единицы человеком; `null` — перехвата нет. */
export function openTakeoverOf(
  state: TaskFoldState,
): { unitId: string; copy: string; seq: number; chatTaskId?: string } | null {
  return state.takeover ?? null;
}

/** Секции вводной, уже отданные сессии: id → sha256 (дельта шлёт только изменённые). */
export function sentOf(state: TaskFoldState, sessionId: string): Readonly<Record<string, string>> {
  return own(state.sent, sessionId) ?? {};
}
