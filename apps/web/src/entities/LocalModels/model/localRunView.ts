import type { LocalActivity } from '@agentdeck/contracts/local-models';

/** С какой тишины чат говорит о ней вслух: короче — обычная пауза между пакетами разбора. */
export const SILENT_AFTER_MS = 20_000;

/**
 * Что показать под ходом локальной модели (L6; этапы — с этапа 11, W2-5, по ленте звена ядра):
 * загрузка, очередь, разбор промпта (сколько из скольких), ответ, тишина и застой. Ядро ленты не
 * дало (`phase` нет) — строка судит по отказу сервера и по времени последнего запроса.
 */
export type LocalRunStage =
  | { key: 'permission' }
  | { key: 'idle' }
  /** Ход идёт, а запроса к модели ещё не было: CLI поднимается и готовит первый. */
  | { key: 'preparing' }
  /** Последний запрос этого хода сервер отверг — «выполняет инструменты» было бы неправдой. */
  | { key: 'failed' }
  | { key: 'starting' }
  | { key: 'loading' }
  | { key: 'queued' }
  | { key: 'prompt'; filled: number; total?: number; share?: number }
  | { key: 'generating'; decoded: number };

export interface LocalRunView {
  server?: { model: string; quant?: string; context?: number };
  stage: LocalRunStage;
  /** Сервер молчит дольше обычной паузы: сколько и через сколько это станет застоем. */
  silent?: { seconds: number; left: number };
  /** Движения нет дольше предела устройства при живом сервере: сколько секунд. */
  stalled?: { seconds: number };
  /** Отказ сервера моделей в этом ходе: код и текст. Удачный ответ его стирает. */
  failed?: { status: number; message: string };
}

/**
 * Ждущее разрешение важнее этапа и отказа: запрос к модели в это время не идёт вовсе, и «читает
 * промпт» было бы неправдой. `since` — начало хода: отказ и запросы раньше него принадлежат
 * прошлому ходу. Хост звеньев не обрывает запрос по тишине — строка лишь называет застой.
 */
export function localRunView(
  activity: LocalActivity | undefined,
  waitingPermission: boolean,
  now: number,
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
  if (!activity?.phase || activity.phase === 'idle' || !activity.inFlight) {
    const before =
      since !== undefined &&
      (activity?.lastRequestAt === undefined || activity.lastRequestAt < since);
    let key: 'idle' | 'preparing' | 'failed' = 'idle';
    if (failed.failed) key = 'failed';
    else if (activity && before) key = 'preparing';
    return { ...base, stage: { key }, ...failed };
  }
  const stage = stageOf(activity);
  const quietMs = activity.lastMoveAt === undefined ? 0 : Math.max(0, now - activity.lastMoveAt);
  const seconds = Math.round(quietMs / 1000);
  // Загрузка и подъём сервера — законное движение без токенов: тишиной не считаются.
  const moving = stage.key !== 'loading' && stage.key !== 'starting';
  if (activity.stalled && moving) return { ...base, stage, stalled: { seconds }, ...failed };
  const silent =
    moving && quietMs >= SILENT_AFTER_MS
      ? {
          silent: {
            seconds,
            left: Math.max(0, Math.round(((activity.stallMs ?? 0) - quietMs) / 1000)),
          },
        }
      : {};
  return { ...base, stage, ...silent, ...failed };
}

function stageOf(activity: LocalActivity): LocalRunStage {
  switch (activity.phase) {
    case 'starting':
      return { key: 'starting' };
    case 'loading':
      return { key: 'loading' };
    case 'prompt': {
      const filled = activity.prompt?.filled ?? 0;
      const total = activity.prompt?.total;
      // Подсчёт меньше прочитанного — другой промпт: доля не показывается, только число.
      return total && total >= filled
        ? { key: 'prompt', filled, total, share: filled / total }
        : { key: 'prompt', filled };
    }
    case 'generating':
      return { key: 'generating', decoded: activity.decoded ?? 0 };
    default:
      return { key: 'queued' };
  }
}
