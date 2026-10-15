import type { LocalActivity } from '@agentdeck/contracts/local-models';

/** С какой тишины чат говорит о ней вслух: короче — обычная пауза между пакетами разбора. */
export const SILENT_AFTER_MS = 20_000;
/** Сколько помнить обрыв по тишине: следующий запрос уже идёт, но человек должен знать, почему. */
export const STALL_MEMORY_MS = 120_000;

export type LocalRunStage =
  | { key: 'permission' }
  | { key: 'idle' }
  /** Ход идёт, а запроса к модели ещё не было: CLI поднимается и готовит первый. */
  | { key: 'preparing' }
  /** Запрос не идёт, и последний сервер отверг — «выполняет инструменты» было бы неправдой. */
  | { key: 'failed' }
  | { key: 'starting' }
  | { key: 'loading' }
  | { key: 'queued' }
  | { key: 'prompt'; filled: number; total?: number; share?: number }
  | { key: 'generating'; decoded: number };

export interface LocalRunView {
  server?: { model: string; quant?: string; context?: number };
  stage: LocalRunStage;
  /** Сервер молчит — сколько и через сколько запрос уйдёт заново; тогда же — кнопка перезапуска. */
  silent?: { seconds: number; left: number };
  /** Недавний обрыв по тишине. */
  stalled?: { seconds: number };
  /** Отказ сервера моделей в этом ходе: код и текст. Удачный ответ его стирает. */
  failed?: { status: number; message: string };
}

/**
 * Что показать под ходом локальной модели. Ждущее разрешение важнее этапа сервера: запрос к
 * модели в это время не идёт вовсе, и «читает промпт» было бы неправдой. `since` — начало хода:
 * отказ и запросы раньше него принадлежат прошлому ходу.
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
  const stalled =
    activity?.lastStall && now - activity.lastStall.at < STALL_MEMORY_MS
      ? { stalled: { seconds: activity.lastStall.seconds } }
      : {};
  const error = activity?.lastError;
  const failed =
    error && (since === undefined || error.at >= since)
      ? { failed: { status: error.status, message: error.message } }
      : {};
  if (waitingPermission) return { ...base, stage: { key: 'permission' }, ...stalled, ...failed };
  if (!activity || activity.phase === 'idle' || activity.inFlight === 0) {
    const before =
      since !== undefined &&
      (activity?.lastRequestAt === undefined || activity.lastRequestAt < since);
    let key: 'idle' | 'preparing' | 'failed' = 'idle';
    if (failed.failed) key = 'failed';
    else if (activity && before) key = 'preparing';
    return { ...base, stage: { key }, ...stalled, ...failed };
  }
  const stage = stageOf(activity);
  const silentMs = activity.silentMs ?? 0;
  const silent =
    silentMs >= SILENT_AFTER_MS && activity.phase !== 'loading'
      ? {
          silent: {
            seconds: Math.round(silentMs / 1000),
            left: Math.max(0, Math.round(((activity.stallMs ?? 0) - silentMs) / 1000)),
          },
        }
      : {};
  return { ...base, stage, ...silent, ...stalled, ...failed };
}

function stageOf(activity: LocalActivity): LocalRunStage {
  switch (activity.phase) {
    case 'starting':
      return { key: 'starting' };
    case 'loading':
      return { key: 'loading' };
    case 'prompt': {
      const filled = activity.filled ?? 0;
      const total = activity.promptTokens;
      // Счёт шлюза бывает оценкой: заполнение больше оценки — доля не показывается, только число.
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
