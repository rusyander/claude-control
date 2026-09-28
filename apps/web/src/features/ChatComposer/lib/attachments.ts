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
  fileToBase64,
  hasRejections,
  pastedName,
  planAttach as planShared,
  uniqueName,
  type AttachPlan,
} from '@shared/lib/attach';
import type { AttachedFile } from '../ui/ChatComposer.types';

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

/** Читает файл в base64 — в таком виде вложение уходит на сервер. */
export async function toAttachedFile(file: File): Promise<AttachedFile> {
  return { name: file.name, sizeBytes: file.size, base64: await fileToBase64(file) };
}

/**
 * Имена вставленных из буфера файлов. Имя вставки — с точностью до секунды, и
 * два снимка одной секунды давали чипы-двойники: какой из них убрать крестиком,
 * было не понять. Занятые — имена уже приложенных файлов.
 */
export function pastedNames(
  pasted: readonly { name: string; type: string }[],
  attached: readonly string[],
  now: Date,
): string[] {
  const taken = new Set(attached);
  return pasted.map((file) => {
    const name = uniqueName(pastedName(file, now), taken);
    taken.add(name);
    return name;
  });
}
