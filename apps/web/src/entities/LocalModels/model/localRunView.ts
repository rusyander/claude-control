import type { LocalActivity } from '@agentdeck/contracts/local-models';

/**
 * Что показать под ходом локальной модели (L6). Этапов хода (загрузка, разбор промпта, ответ)
 * нет: запросы ведёт ядро, а ленты активности звена у него пока нет — строка судит по отказу
 * сервера и по времени последнего запроса.
 */
export type LocalRunStage =
  | { key: 'permission' }
  | { key: 'idle' }
  /** Ход идёт, а запроса к модели ещё не было: CLI поднимается и готовит первый. */
  | { key: 'preparing' }
  /** Последний запрос этого хода сервер отверг — «выполняет инструменты» было бы неправдой. */
  | { key: 'failed' };

export interface LocalRunView {
  server?: { model: string; quant?: string; context?: number };
  stage: LocalRunStage;
  /** Отказ сервера моделей в этом ходе: код и текст. Удачный ответ его стирает. */
  failed?: { status: number; message: string };
}

/**
 * Ждущее разрешение важнее отказа: запрос к модели в это время не идёт вовсе. `since` — начало
 * хода: отказ и запросы раньше него принадлежат прошлому ходу.
 */
export function localRunView(
  activity: LocalActivity | undefined,
  waitingPermission: boolean,
  since?: number,
): LocalRunView {
  const server = activity?.model
    ? {
        model: activity.model,
        ...(activity.quant ? { quant: activity.quant } : {}),
        ...(activity.context ? { context: activity.context } : {}),
      }
    : undefined;
  const base = server ? { server } : {};
  const error = activity?.lastError;
  const failed =
    error && (since === undefined || error.at >= since)
      ? { failed: { status: error.status, message: error.message } }
      : {};
  if (waitingPermission) return { ...base, stage: { key: 'permission' }, ...failed };
  const before =
    since !== undefined &&
    (activity?.lastRequestAt === undefined || activity.lastRequestAt < since);
  let key: 'idle' | 'preparing' | 'failed' = 'idle';
  if (failed.failed) key = 'failed';
  else if (activity && before) key = 'preparing';
  return { ...base, stage: { key }, ...failed };
}
