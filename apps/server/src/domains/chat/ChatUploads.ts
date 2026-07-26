import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
// Список расширений — ОДИН на сервер, фронт и поле выбора файла; он лежит в
// contracts отдельной точкой экспорта (бочку без расширений Node не резолвит,
// см. комментарий в самом файле).
import { SUPPORTED_UPLOAD_EXTENSIONS, isSupportedUpload } from '@claude-control/contracts/uploads';

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

/** Сохраняет вложение в папку чата. Содержимое приходит строкой base64. */
export function saveUpload(chatDir: string, name: string, base64: string): UploadedFile {
  const safeName = basename(name).replace(/[^a-zA-Z0-9._\- ]/g, '_');
  const path = join(chatDir, safeName);
  const buffer = Buffer.from(base64, 'base64');

  writeFileSync(path, buffer);

  return { name: safeName, path, sizeBytes: buffer.length };
}

/**
 * Промпт с вложениями. Пути перечисляются явно: без этого Claude не догадается
 * заглянуть в файлы, даже когда они лежат рядом в рабочей папке.
 */
export function buildPromptWithFiles(prompt: string, files: UploadedFile[]): string {
  if (files.length === 0) return prompt;

  const list = files.map((file) => `- ${file.path}`).join('\n');
  return `${prompt}\n\nПриложенные файлы (прочитай их):\n${list}`;
}
