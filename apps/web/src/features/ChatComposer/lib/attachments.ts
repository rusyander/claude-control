/**
 * Что делать с приложенными файлами.
 *
 * Правило вынесено сюда по той же причине, что и проверка расширений
 * (`pages/Chat/lib/uploads.ts`): отказ обязан быть виден. Раньше слишком
 * большой файл просто отсеивался в composer'е — ни чипа, ни сообщения; со
 * стороны это выглядело сломанным перетаскиванием, и человек пробовал снова.
 *
 * Тип файла проверяется здесь же, в момент вложения. Раньше .exe ложился
 * чипом и отвергался только при отправке — человек успевал набрать сообщение
 * под вложение, которое никуда не уйдёт (кейс chat-004). Проверка при отправке
 * осталась страховкой; предикат у обеих один — из `@agentdeck/contracts/uploads`,
 * оттуда же его берёт сервер.
 */

import { isSupportedUpload } from '@agentdeck/contracts/uploads';
import {
  ATTACH_MAX_BYTES,
  hasRejections,
  planAttach as planShared,
  type AttachPlan,
} from '@shared/lib/attach';

/**
 * Больше этого размера файл не приложить: он поедет в теле запроса. Предел общий
 * со всеми полями агента (`@shared/lib/attach`).
 */
export const MAX_FILE_BYTES = ATTACH_MAX_BYTES;

export type { AttachPlan };
export { hasRejections };

/** План вложения чата: принимаются все типы, которые панель передаёт в папку чата. */
export function planAttach<T extends { name: string; size: number }>(
  files: T[],
  maxBytes: number = MAX_FILE_BYTES,
): AttachPlan<T> {
  return planShared(files, { accepts: isSupportedUpload, maxBytes });
}
