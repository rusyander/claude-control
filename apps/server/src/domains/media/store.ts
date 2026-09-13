import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaImage } from '@agentdeck/contracts';
import { MEDIA_KEEP_FILES } from '@agentdeck/contracts/media';
import { writeBinaryFile, writeJsonFile, removeEntry } from '../../lib/safe-io.ts';
import { MediaError } from './errors.ts';

/**
 * Файлы картинок в каталоге данных панели.
 *
 * Пара файлов на картинку: сами байты и запись рядом (`<id>.json`). Запись
 * отдельным файлом, а не строкой в `state.json`, — требование задачи и здравого
 * смысла сразу: настройки панели человек читает и переносит архивом, и мегабайты
 * base64 в них означали бы и нечитаемый файл, и распухший перенос. Обратная
 * сторона решения: каталог — единственный источник правды о картинках, и
 * потерянный `.json` делает файл байтами без имени. Поэтому запись пишется ПОСЛЕ
 * байтов: пара без записи видна как сирота и подметается, а запись без байтов
 * означала бы карточку, которая ничего не покажет.
 */

/**
 * Расширение по типу — список закрыт ровно как у показа файлов проекта.
 *
 * Вектор в списке есть, но попасть сюда он может только одной дорогой — блоком
 * агента через `checkPicture` (`media.ts → mediaImageMimes` его намеренно не
 * знает, чтобы чужая ручка не сохранила SVG со скриптом внутри).
 */
const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** Идентификатор картинки: только то, что панель сама и сгенерировала. */
const ID_RE = /^[0-9a-f]{16,32}$/;

/** Расширение файла по типу. Неизвестного типа сюда не доходит — список закрыт. */
export function extensionFor(mime: string): string {
  return EXTENSION[mime] ?? 'bin';
}

export function mediaDir(appDataDir: string): string {
  return join(appDataDir, 'media');
}

/**
 * Путь к файлу картинки по записи. Имя собирается из ПРОВЕРЕННОГО
 * идентификатора и типа из закрытого списка: часть пути, пришедшая из запроса,
 * иначе вывела бы чтение за каталог данных.
 */
export function imagePath(appDataDir: string, image: MediaImage): string {
  return join(mediaDir(appDataDir), `${assertId(image.id)}.${EXTENSION[image.mime] ?? 'bin'}`);
}

function recordPath(appDataDir: string, id: string): string {
  return join(mediaDir(appDataDir), `${assertId(id)}.json`);
}

export function assertId(id: string): string {
  if (!ID_RE.test(id))
    throw new MediaError(400, 'Идентификатор картинки не тот, что выдаёт панель');
  return id;
}

/** Записать байты и запись о них. Возвращает запись — её же отдаёт маршрут. */
export function saveImage(appDataDir: string, image: MediaImage, bytes: Buffer): MediaImage {
  mkdirSync(mediaDir(appDataDir), { recursive: true });
  writeBinaryFile(imagePath(appDataDir, image), bytes);
  writeJsonFile(recordPath(appDataDir, image.id), image);
  trimImages(appDataDir);
  return image;
}

/** Запись о картинке; `undefined` — такой картинки у панели нет. */
export function readImageRecord(appDataDir: string, id: string): MediaImage | undefined {
  const path = recordPath(appDataDir, id);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as MediaImage;
    return raw && typeof raw.id === 'string' && raw.id === id ? raw : undefined;
  } catch {
    // Битый `.json` — это не 500: картинки у панели нет, и сказать надо именно
    // это. Файл байтов подметётся вместе с сиротами.
    return undefined;
  }
}

/** Байты картинки. Отсутствие файла при живой записи — тоже «нет картинки». */
export function readImageBytes(appDataDir: string, image: MediaImage): Buffer {
  const path = imagePath(appDataDir, image);
  if (!existsSync(path)) throw new MediaError(404, 'Файл картинки панель не нашла');
  return readFileSync(path);
}

/**
 * Подметание каталога: держим только последние `MEDIA_KEEP_FILES` картинок.
 *
 * Потолок, а не бесконечный рост: галереи в Т9 нет намеренно, удалять картинки
 * человеку негде, а каждая — мегабайты. Считается по записям (`.json`), и вместе
 * с записью уходят её байты; файл байтов без записи — сирота от прерванной
 * записи, он подметается сразу.
 */
export function trimImages(appDataDir: string): void {
  const dir = mediaDir(appDataDir);
  if (!existsSync(dir)) return;

  const records: Array<{ id: string; at: number }> = [];
  const bytes = new Map<string, string>();

  for (const name of readdirSync(dir)) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) continue;
    const id = name.slice(0, dot);
    if (!ID_RE.test(id)) continue;
    const full = join(dir, name);
    if (name.endsWith('.json')) {
      records.push({ id, at: statSync(full).mtimeMs });
    } else {
      bytes.set(id, full);
    }
  }

  records.sort((left, right) => right.at - left.at);
  const kept = new Set(records.slice(0, MEDIA_KEEP_FILES).map((record) => record.id));

  for (const record of records) {
    if (kept.has(record.id)) continue;
    removeEntry(recordPath(appDataDir, record.id));
    const file = bytes.get(record.id);
    if (file) removeEntry(file);
  }
  // Байты без записи: запись прервалась между двумя файлами, и показать такую
  // картинку всё равно нечем — имени, промпта и типа у неё нет.
  for (const [id, file] of bytes) {
    if (!records.some((record) => record.id === id)) removeEntry(file);
  }
}
