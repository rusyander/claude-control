import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeBinaryFile } from '../../../lib/safe-io/safe-io.ts';
import { ProjectTestsError, testsFile, testsPath } from '../files.ts';
import { coded } from '../../../lib/server-text/server-text.ts';

/**
 * Доказательства к кейсу: скриншоты и логи в `.agent/tests/attachments/<кейс>/`.
 *
 * Без них провал остаётся словом «не работает». Файлы лежат в проекте рядом с
 * кейсами — значит, попадают в ревью и не зависят от того, жива ли панель.
 *
 * Имя файла чистится жёстко: оно приходит из браузера, а мы кладём его на диск.
 * Расширение разрешено не любое — сюда попадают картинки и текст, и ничего
 * такого, что кто-то потом откроет двойным щелчком.
 */

const DIR = 'attachments';

/** Что панель принимает как доказательство. */
const ALLOWED = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.log', '.json', '.har', '.md'];

/** Потолок на файл: скриншот страницы — это сотни килобайт, не десятки мегабайт. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Безопасное имя файла: без путей, без пробелов по краям, с разрешённым расширением. */
function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) throw coded(new ProjectTestsError('У файла нет имени.'), 'attachment-name-missing');
  const dot = cleaned.lastIndexOf('.');
  const extension = dot >= 0 ? cleaned.slice(dot).toLowerCase() : '';
  if (!ALLOWED.includes(extension)) {
    throw coded(
      new ProjectTestsError(
        `Такие файлы к кейсу не прикладываются: ${extension || 'без расширения'}.`,
      ),
      'attachment-type-unsupported',
      { extension: extension || '—' },
    );
  }
  return cleaned;
}

/** Путь вложения от папки тестов — один расчёт для записи и для карточки агента. */
function attachmentRelative(caseId: string, name: string, now: string): string {
  const cleanCase = caseId.replace(/[^A-Za-z0-9._-]+/g, '-');
  if (!cleanCase)
    throw coded(
      new ProjectTestsError('Не указан кейс, к которому прикладывается файл.'),
      'attachment-case-missing',
    );
  // Время в имени: один и тот же скриншот кладут повторно при перепрохождении,
  // и затирать прошлое доказательство нельзя — по нему сравнивают «было/стало».
  // С датой: одно время суток в другой день затёрло бы вчерашний файл.
  const stamp = now.replace(/[^0-9]/g, '').slice(0, 14);
  return `${DIR}/${cleanCase}/${stamp}-${safeName(name)}`;
}

/**
 * Куда ляжет вложение, от корня проекта, — ровно то, что вернёт `saveAttachment`
 * с тем же `now`. Карточка агента называет этот путь до записи.
 */
export function attachmentFile(caseId: string, name: string, now: string): string {
  return testsFile(attachmentRelative(caseId, name, now));
}

/**
 * Сохранить вложение. Возвращает путь от корня проекта — именно он попадает в
 * кейс и в результат прогона, потому что абсолютный путь на другой машине врёт.
 */
export function saveAttachment(
  root: string,
  caseId: string,
  name: string,
  contentBase64: string,
  now: string,
): string {
  const relative = attachmentRelative(caseId, name, now);

  const buffer = Buffer.from(contentBase64, 'base64');
  if (buffer.byteLength === 0)
    throw coded(new ProjectTestsError('Файл пустой.'), 'attachment-empty');
  if (buffer.byteLength > MAX_BYTES)
    throw coded(new ProjectTestsError('Файл больше 8 МБ.'), 'attachment-too-large');

  const path = testsPath(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeBinaryFile(path, buffer);
  return testsFile(relative);
}
