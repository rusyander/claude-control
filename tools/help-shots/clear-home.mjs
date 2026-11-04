/**
 * Очистить дом съёмки ПО СОДЕРЖИМОМУ, а не сносом одним вызовом.
 *
 * Дом целей переносимости (`../.cc-help-portability`) — фиксированный путь: он виден в кадрах и
 * совпадает с коммитом. 03.11.2026 пустой каталог `.agentdeck\core` в нём держал неизвестный
 * процесс (EBUSY), и `rmSync(дом)` ронял съёмку до первого кадра — а обход через другой дом
 * (`GUIDE_PORTABILITY_HOME`) менял путь в каждом кадре. Пустой занятый каталог съёмке не мешает:
 * в нём ничего не лежит, и следующий прогон начинает с чистого дома. Поэтому снимается всё, что
 * снимается, а занятый каталог остаётся, только если после очистки он ПУСТ (или содержит лишь
 * такие же оставленные каталоги). Занят и не пуст — остался чужой файл, и это прежний отказ.
 */
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

const BUSY = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/** Ошибка «дом держат с содержимым»: `path` — что не снялось, `code` — ответ системы. */
export class HomeHeldError extends Error {
  constructor(path, code) {
    super(`${path} занят (${code}), и внутри остались файлы`);
    this.name = 'HomeHeldError';
    this.path = path;
    this.code = code;
  }
}

/**
 * Снять `dir` по содержимому. Возвращает занятые пустые каталоги, которые остались (сам `dir`
 * среди них, если занят он); их родители до `dir` остаются тоже, но в список не входят — их никто
 * не держит. Каталога нет — пустой список. Не снялся файл — `HomeHeldError`.
 */
export function clearHomeByContent(dir) {
  if (!existsSync(dir)) return [];
  try {
    rmSync(dir, { recursive: true, force: true });
    return [];
  } catch (error) {
    if (!BUSY.has(error?.code)) throw error;
  }
  const kept = [];
  clearDir(dir, kept);
  return kept;
}

/** Каталог пуст после очистки детей и снят; занят — оставлен (в `kept`); держит оставленного — оставлен молча. */
function clearDir(dir, kept) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const isDir = lstatSync(path).isDirectory();
    try {
      rmSync(path, { recursive: true, force: true });
      continue;
    } catch (error) {
      if (!BUSY.has(error?.code)) throw error;
      if (!isDir) throw new HomeHeldError(path, error.code);
    }
    clearDir(path, kept);
  }
  // Внутри остались только оставленные занятые каталоги — сам каталог остаётся, но его не держат.
  if (readdirSync(dir).length > 0) return;
  try {
    rmdirSync(dir);
  } catch (error) {
    if (!BUSY.has(error?.code)) throw error;
    kept.push(dir);
  }
}
