import type { MediaImageBlocker } from '@agentdeck/contracts/media';
import type { MediaDeckBlocker } from '@agentdeck/contracts/media-deck';

/** Машинная причина отказа: недоступность режима картинки или презентации. */
export type MediaReason = MediaImageBlocker | MediaDeckBlocker;

/**
 * Отказ режима картинок — с кодом ответа и человеческой причиной.
 *
 * Своя ошибка, а не строка в ответе, по той же причине, что и у промптов: отказ
 * приходит из глубины (маршрут не собрался, контур ответил не тем, байты не
 * картинка), а решает, каким статусом это отдать, ровно один слой — маршрут.
 *
 * Без свойств-параметров конструктора: сервер идёт под `erasableSyntaxOnly`.
 */
export class MediaError extends Error {
  readonly status: number;
  /** Машинная причина, если отказ — это недоступность режима. */
  readonly reason?: MediaReason;

  constructor(status: number, message: string, reason?: MediaReason) {
    super(message);
    this.name = 'MediaError';
    this.status = status;
    this.reason = reason;
  }
}

export function isMediaError(error: unknown): error is MediaError {
  return error instanceof MediaError;
}
