import { stoppedTaskOf } from './bg-tasks.ts';
import { capped } from './reduce-util.ts';
import { admissionOf } from './word-admission.ts';
import type { OpenTool, WatchContext, WatchEvent, WatchState } from './watch.types.ts';

/**
 * Свёртка для правил, перенесённых из внешнего сторожа 27.10: начало хода (эскалация
 * кругов), вызов шёл долго и фон открыт долго (R16), длинная вводная (R37), признание
 * пропуска в итоге хода (R44). Отдельно от `reduce.ts`: тот и так на пределе размера.
 */

/** Вызовы, которые ждут по своей природе: субагент, вопрос человеку. Их длительность — не диво. */
const WAITING_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);
/** Сколько поводов «шёл долго», вводных и признаний держим: правило-событие держится полчаса. */
const EMBED_CAP = 20;
/** Фоновая задача без конца дольше двух часов — забытая запись, а не работа (внешний bgStaleMs). */
export const BG_STALE_MS = 2 * 60 * 60_000;

/** Начало хода: эскалация кругов считает поводы с него; длинная вводная — повод R37. */
export function noteEmbedStart(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'start' }>,
  ctx: WatchContext,
): void {
  state.turnAt = event.t;
  if (event.chars !== undefined && event.chars >= ctx.settings.briefChars) {
    capped((state.briefs ??= []), { at: event.t, chars: event.chars }, EMBED_CAP);
  }
}

/** Конец хода: итоговый текст признаёт пропуск — повод R44 (`endText` ставит `noteTurnEnd`). */
export function noteEmbedEnd(state: WatchState, t: number): void {
  const admission = state.endText ? admissionOf(state.endText) : undefined;
  if (admission) capped((state.admissions ??= []), { at: t, ...admission }, EMBED_CAP);
}

/**
 * Результат вызова: ушёл в фон — запись открыта до уведомления или остановки; кончился
 * на переднем плане, шёл дольше `slowSeconds` и вдвое дольше опыта очереди — «шёл долго».
 */
export function noteEmbedResult(
  state: WatchState,
  tool: OpenTool,
  event: Extract<WatchEvent, { kind: 'toolResult' }>,
  ctx: WatchContext,
): void {
  const label = tool.label ?? tool.name;
  if (event.bgTaskId) {
    (state.bgTasks ??= {})[event.bgTaskId] = { at: event.t, label };
    return;
  }
  if (tool.background || WAITING_TOOLS.has(tool.name) || event.denied) return;
  const ranMs = event.t - tool.startedAt;
  const floor = Math.max(
    ctx.settings.slowSeconds * 1000,
    tool.expectMs !== undefined ? 2 * tool.expectMs : 0,
  );
  if (!(ranMs >= floor)) return;
  capped(
    (state.slowCalls ??= []),
    {
      at: event.t,
      ranMs,
      ...(tool.expectMs !== undefined ? { expectMs: tool.expectMs } : {}),
      label,
    },
    EMBED_CAP,
  );
}

/** Фоновая задача кончилась (уведомление) — запись закрыта. */
export function noteBgDone(state: WatchState, taskId: string): void {
  if (state.bgTasks) delete state.bgTasks[taskId];
}

/**
 * Остановка фоновой задачи вызовом (`TaskStop`, `KillShell`): уведомления о ней не будет —
 * запись закрывается сразу (g8 26.10: grep остановлен в 03:07, а внешний сторож через 13 мин
 * назвал его «фон долго»).
 */
export function noteBgStop(state: WatchState, event: Extract<WatchEvent, { kind: 'tool' }>): void {
  const taskId = stoppedTaskOf(event.name, event.input);
  if (taskId) noteBgDone(state, taskId);
}
