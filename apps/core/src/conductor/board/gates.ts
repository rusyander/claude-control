import {
  BOARD_DEFAULTS,
  type BoardSection,
  type ConfigView,
} from '@agentdeck/contracts/core/config';
import type { BoardEntry, BoardLimits } from '@agentdeck/contracts/core/board';
import { taskWaits } from '@agentdeck/contracts/core/waiting';
import { openTakeoverOf } from '../../journal/reduce/fold-view.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { isChatTask } from './stage.ts';

/**
 * Пределы доски (этап 12, P154, P155): сколько задач «в работе» и сколько стартов за местные сутки.
 * «В работе» — задача, которая ест место: оценивается, идёт, публикуется или ждёт окна. Не ест —
 * задача, которая ждёт человека и у которой нет живого сеанса (вопрос держит её, модель не
 * работает), и задача в перехвате (её ведёт человек в своей копии). Старт в полёте (запись в
 * `starting` без задачи) место держит: иначе два такта подряд начали бы два старта на одно место.
 */

const IN_WORK: ReadonlySet<string> = new Set([
  'estimating',
  'running',
  'publishing',
  'waiting-window',
]);
const OPEN_SESSION: ReadonlySet<string> = new Set(['starting', 'live', 'quiet']);
const DAY_MS = 86_400_000;

function hasOpenSession(state: TaskFoldState): boolean {
  return Object.values(state.sessions).some((s) => OPEN_SESSION.has(s.state));
}

/** Ест ли задача место доски сейчас. */
export function holdsSlot(state: TaskFoldState): boolean {
  if (isChatTask(state) || state.ended !== null) return false;
  if (!IN_WORK.has(state.task)) return false;
  if (openTakeoverOf(state)) return false;
  // Ждёт человека и модель молчит: место свободно для следующей задачи (P153).
  if (taskWaits(Object.values(state.asks)) && !hasOpenSession(state)) return false;
  return true;
}

export function inWorkOf(states: readonly TaskFoldState[], entries: readonly BoardEntry[]): number {
  const busy = states.filter(holdsSlot).length;
  const inFlight = entries.filter((e) => e.state === 'starting' && e.taskId === undefined).length;
  return busy + inFlight;
}

/** Начало местных суток `now` (пояс процесса ядра — пояс человека на этой машине). */
export function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Стартов доски за местные сутки `now`: запись получает `startedAt`, когда старт начат. */
export function startsToday(entries: readonly BoardEntry[], now: number): number {
  const from = localDayStart(now);
  return entries.filter(
    (e) => e.startedAt !== undefined && e.startedAt >= from && e.startedAt < from + DAY_MS,
  ).length;
}

/** Раздел `board` действующей настройки; нет раздела — умолчания; нечитаемая — `unknown`. */
export function boardSectionOf(
  view: { value: ConfigView } | { unknown: string },
): { value: BoardSection } | { unknown: string } {
  if ('unknown' in view) return { unknown: view.unknown };
  return { value: view.value.doc.board ?? BOARD_DEFAULTS };
}

/**
 * Жалобы настройки, из-за которых доска на умолчаниях: негодный раздел `board` (читатель не взял
 * его в документ) или нечитаемая настройка целиком. Прочие разделы доски не касаются.
 */
export function boardConfigIssuesOf(
  view: { value: ConfigView } | { unknown: string },
): { section: string; reason: string }[] {
  if ('unknown' in view) return [{ section: '*', reason: view.unknown }];
  return view.value.issues.filter((i) => i.section === 'board');
}

export function limitsOf(
  section: BoardSection,
  states: readonly TaskFoldState[],
  entries: readonly BoardEntry[],
  now: number,
): BoardLimits {
  return {
    inWork: { used: inWorkOf(states, entries), cap: section.inWork },
    perDay: { used: startsToday(entries, now), cap: section.perDay },
    paused: section.paused,
    stopOnQuestion: section.stopOnQuestion,
    defaultStop: section.defaultStop,
  };
}

/** Ждёт ли хоть одна карточка человека (для `stopOnQuestion`). */
export function anyWaiting(states: readonly TaskFoldState[]): boolean {
  return states.some((s) => !isChatTask(s) && s.ended === null && taskWaits(Object.values(s.asks)));
}
