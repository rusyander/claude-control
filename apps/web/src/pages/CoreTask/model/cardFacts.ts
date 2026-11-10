import type { BoardCard } from '@agentdeck/contracts/core/board';
import type { TaskView } from '@agentdeck/contracts/core/task-view';

/**
 * Факты окна карточки (этап 12, D14, P160): каждое поле — из карточки доски или вида задачи
 * (свёртки журнала ядра). Нет факта — `null`, и окно пишет «нет данных», а не 0: ноль токенов у
 * записи, которая ещё не стартовала, читался бы как «задача ничего не потратила».
 */

/** Сеансы, которые сейчас держат агента (ещё не закончились и не потеряны). */
const RUNNING_SESSIONS: ReadonlySet<string> = new Set(['starting', 'live', 'quiet']);

export interface AgentsFact {
  now: number;
  total: number;
}

/** Агенты задачи: сейчас — живые сеансы, всего — все сеансы журнала. Вида нет — `null`. */
export function agentsOf(view: TaskView | undefined): AgentsFact | null {
  if (!view) return null;
  return {
    now: view.sessions.filter((s) => RUNNING_SESSIONS.has(s.state)).length,
    total: view.sessions.length,
  };
}

export interface SpendFact {
  tokens: number;
  turns: number;
}

/**
 * Расход задачи из `spendOf` ядра: токены всех видов и ходы. Вида нет или ни одного хода и токена
 * (задача не дошла до модели) — `null`: такой «0» — отсутствие факта, а не нулевой расход.
 */
export function spendOfView(view: TaskView | undefined): SpendFact | null {
  if (!view) return null;
  const t = view.spend.tokens;
  const tokens = t.input + t.cacheRead + t.cacheWrite + t.cacheWrite1h + t.output;
  if (tokens === 0 && t.turns === 0) return null;
  return { tokens, turns: t.turns };
}

/**
 * Оценка до запуска — сумма оценок токенов единиц последнего деления. Деления нет или ни у одной
 * единицы нет оценки — `null`; единица без оценки в сумму не входит (сумма — нижняя граница).
 */
export function estimateOfView(view: TaskView | undefined): number | null {
  const units = view?.split?.units ?? [];
  const known = units.map((u) => u.estimate.tokens).filter((n): n is number => n !== null);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
}

export interface UnitProgress {
  n: number;
  unitId: string;
  /** Вид последнего шага единицы (`stepKind`) и его состояние. */
  step: string;
  state: string;
}

/** Ход по единицам: последний шаг каждой единицы, единицы — в порядке первого шага. */
export function unitsOfView(view: TaskView | undefined): UnitProgress[] {
  if (!view) return [];
  const last = new Map<string, TaskView['steps'][number]>();
  for (const step of [...view.steps].sort((a, b) => a.startedSeq - b.startedSeq)) {
    last.set(step.unitId, step);
  }
  return [...last.values()].map((step, i) => ({
    n: i + 1,
    unitId: step.unitId,
    step: step.stepKind,
    state: step.state,
  }));
}

export interface MrFact {
  url: string;
  iid: number;
  title: string | undefined;
  state: 'opened' | 'merged' | 'closed';
}

/** MR: с карточки доски (ядро уже выбрало главный), иначе последний из вида задачи. */
export function mrOf(card: BoardCard, view: TaskView | undefined): MrFact | null {
  const mr = card.mr ?? view?.mrs?.at(-1);
  return mr ? { url: mr.url, iid: mr.iid, title: mr.title, state: mr.state } : null;
}

/** Сценарий: действующая версия из вида (`id@версия`), иначе пресет записи; нет ни того ни другого — `null`. */
export function scenarioOf(card: BoardCard, view: TaskView | undefined): string | null {
  const ref = view?.scenario?.ref;
  if (ref) return `${ref.id}@${ref.version}`;
  return card.preset ?? null;
}

/** Класс и профиль ведущего: из карточки, иначе из вида; нет ни одного — `null`. */
export function leadOf(card: BoardCard, view: TaskView | undefined): string | null {
  const parts = [card.lead?.class ?? view?.class, card.lead?.profile ?? view?.profile].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}
