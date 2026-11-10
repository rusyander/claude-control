import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { CoreChatBook, CoreChatPort } from './core-run.types.ts';

/** Причина отмены в журнале задачи ядра: доска и чат показывают, почему повтора не будет. */
export const carryCancelReason = (cli: string): string =>
  `carried to ${cli} by the human in the panel: the message is not sent again on this CLI after the window reset`;

export interface CarryCancelDeps {
  book: Pick<CoreChatBook, 'get' | 'forget'>;
  port: Pick<CoreChatPort, 'view' | 'command'>;
}

/** Id разговора книги по ключу переноса: у Claude ключ — сам id, у чужого CLI — `<cli>:<id>`. */
const conversationOf = (key: string): string => parseForeignChatKey(key)?.chatId ?? key;

/** Окно маршрута закрыто отказом: слово ушло в отказ и ждёт сброса. */
const SHUT = new Set(['refused', 'exhausted']);

/**
 * Повтор после сброса впереди: задача ждёт окно — или ход только что упёрся в отказ окна, а в
 * ожидание задача ещё не перешла (карточка лимита видна по ленте раньше, чем сеанс сдан ядром;
 * живой стенд ловил перенос через полсекунды после отказа, задача была ещё `running`).
 */
function resendAhead(view: TaskView): boolean {
  if (view.ended) return false;
  if (view.state === 'waiting-window' || view.windowWait) return true;
  return view.windows.some((w) => SHUT.has(w.verdict));
}

/**
 * Перенос разговора, упёршегося в окно (этап 12, ревью R6): «Перенести в X» — клик человека,
 * выбравшего, где разговор продолжится. Задача ядра прежнего разговора, ждущая сброса окна,
 * иначе после сброса пошлёт то же слово прежнему CLI ещё раз — второй ответ мимо продолжения и
 * трата окна того CLI. Поэтому каждый УСПЕШНО перенесённый разговор отменяет свою задачу командой
 * ядра `cancel` с причиной (журнал задачи), а книга её забывает: следующий ход этого разговора,
 * если человек вернётся, начнёт новую задачу. Задачу без повтора впереди (окно открыто или задача
 * кончилась) перенос не трогает. Ядро недоступно — повтор останется: перенос уже случился,
 * отменять его нечем, а молчаливой правки задачи в обход ядра нет.
 */
export async function cancelCarriedResends(
  carriedKeys: readonly string[],
  targetCli: string,
  deps: CarryCancelDeps,
): Promise<string[]> {
  const cancelled: string[] = [];
  for (const key of carriedKeys) {
    const conversation = conversationOf(key);
    const entry = deps.book.get(conversation);
    if (!entry) continue;
    const view = await deps.port.view(entry.taskId).catch(() => null);
    if (!view || !resendAhead(view)) continue;
    const out = await deps.port
      .command(entry.taskId, 'cancel', { reason: carryCancelReason(targetCli) })
      .catch(() => null);
    if (out?.status !== 'applied') continue;
    deps.book.forget(conversation);
    cancelled.push(entry.taskId);
  }
  return cancelled;
}
