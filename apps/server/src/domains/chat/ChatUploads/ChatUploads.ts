import { existsSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
// Список расширений — ОДИН на сервер, фронт и поле выбора файла; он лежит в
// contracts отдельной точкой экспорта (бочку без расширений Node не резолвит,
// см. комментарий в самом файле).
import {
  ATTACHMENTS_MARKER,
  SUPPORTED_UPLOAD_EXTENSIONS,
  isSupportedUpload,
} from '@agentdeck/contracts/uploads';

/**
 * Файлы, которые пользователь прикладывает к сообщению. Claude Code читает их
 * с диска сам — и картинки, и PDF, — поэтому вложение достаточно положить в
 * рабочую папку чата и назвать путь в промпте. Передавать содержимое внутри
 * запроса не нужно и невозможно: у CLI такого входа нет.
 */

export interface UploadedFile {
  name: string;
  path: string;
  sizeBytes: number;
}

/**
 * Реэкспорт для потребителей внутри сервера: отклонённое вложение не пропадает
 * молча — пользователю называют, что именно панель принимает.
 */
export { SUPPORTED_UPLOAD_EXTENSIONS, isSupportedUpload };

/**
 * Безопасное имя файла из того, что прислал клиент.
 *
 * Имя приходит из запроса, поэтому от него остаётся только последний сегмент
 * (обратные слэши считаются разделителем на любой платформе — иначе на Linux
 * `..\..\x` прошёл бы как одно имя), а всё, кроме букв, цифр, точки, дефиса,
 * подчёркивания и пробела, становится «_». Буквы — ЛЮБОГО алфавита: раньше
 * латиница была единственной, и `отчёт.txt` со `схема.txt` превращались в один
 * и тот же `_____.txt` — второй файл молча затирал первый, а агент читал не то.
 */
export function safeUploadName(name: string): string {
  const last = basename(name.replace(/\\/g, '/'));
  const cleaned = last.replace(/[^\p{L}\p{N}._\- ]/gu, '_').trim();
  // Одни точки — это `.` и `..`, то есть не имя вовсе.
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : 'file';
}

/**
 * Имя, ещё не занятое в папке чата: `note.txt` → `note-2.txt` → `note-3.txt`.
 * Затирать нельзя — предыдущее вложение с тем же именем уже названо в прошлом
 * промпте, и агент, вернувшись к нему, прочитал бы уже другой файл.
 */
function unoccupiedName(chatDir: string, name: string): string {
  if (!existsSync(join(chatDir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existsSync(join(chatDir, candidate))) return candidate;
  }
}

/** Сохраняет вложение в папку чата. Содержимое приходит строкой base64. */
export function saveUpload(chatDir: string, name: string, base64: string): UploadedFile {
  const safeName = unoccupiedName(chatDir, safeUploadName(name));
  const path = join(chatDir, safeName);
  const buffer = Buffer.from(base64, 'base64');

  writeFileSync(path, buffer);

  return { name: safeName, path, sizeBytes: buffer.length };
}

/**
 * Промпт с вложениями. Пути перечисляются явно: без этого Claude не догадается
 * заглянуть в файлы, даже когда они лежат рядом в рабочей папке. Разделитель —
 * общий с фронтом маркер: по нему лента рисует чипы, а заголовок разговора
 * берётся из текста ДО него.
 */
export function buildPromptWithFiles(prompt: string, files: UploadedFile[]): string {
  if (files.length === 0) return prompt;

  const list = files.map((file) => `- ${file.path}`).join('\n');
  return `${prompt}\n\n${ATTACHMENTS_MARKER}\n${list}`;
}
