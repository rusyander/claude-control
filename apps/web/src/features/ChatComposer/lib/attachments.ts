/**
 * Что делать с приложенными файлами.
 *
 * Правило вынесено сюда по той же причине, что и проверка расширений
 * (`pages/Chat/lib/uploads.ts`): отказ обязан быть виден. Раньше слишком
 * большой файл просто отсеивался в composer'е — ни чипа, ни сообщения; со
 * стороны это выглядело сломанным перетаскиванием, и человек пробовал снова.
 */

import type { AttachedFile } from '../ui/ChatComposer.types';

/** Больше этого размера файл не приложить: он поедет в теле запроса. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface AttachPlan<T> {
  /** Файлы, которые пойдут в чипы (их читаем в base64). */
  accepted: T[];
  /** Имена отсеянных по размеру — их называют человеку. */
  rejected: string[];
}

export function planAttach<T extends { name: string; size: number }>(
  files: T[],
  maxBytes: number = MAX_FILE_BYTES,
): AttachPlan<T> {
  const accepted: T[] = [];
  const rejected: string[] = [];

  for (const file of files) {
    // Ровно на границе — ещё приложим: предел объявлен как «до 20 МБ».
    if (file.size <= maxBytes) accepted.push(file);
    else rejected.push(file.name);
  }

  return { accepted, rejected };
}

/** Читает файл в base64 — в таком виде вложение уходит на сервер. */
export async function toAttachedFile(file: File): Promise<AttachedFile> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // btoa не принимает большие строки целиком — собираем порциями.
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }

  return { name: file.name, sizeBytes: file.size, base64: btoa(binary) };
}
