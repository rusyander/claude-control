import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Deck, MediaDeck, MediaDeckFormat } from '@agentdeck/contracts';
import { DECK_KEEP_FILES } from '@agentdeck/contracts/media-deck';
import { writeBinaryFile, writeJsonFile, removeEntry } from '../../../lib/safe-io.ts';
import { MediaError } from '../errors.ts';
import { assertId } from '../store.ts';

/**
 * Файлы колод в каталоге данных панели: `<appData>/media/decks/`.
 *
 * Своя папка рядом с картинками, а не общая с ними: у колоды НЕСКОЛЬКО файлов на
 * один идентификатор (`<id>.json`, `.html`, `.pptx`, и `.pdf` после первой
 * печати), а подметальщик картинок считает пары «запись + байты» и на тройке
 * файлов удалял бы не всё. Разделение папок стоило одной строки и сняло целый
 * класс тихих потерь.
 *
 * Порядок записи тот же, что у картинок, и по той же причине: СНАЧАЛА файлы,
 * запись — последней. Файл без записи виден как сирота и подметается; запись без
 * файлов означала бы карточку, которая ничего не покажет.
 *
 * САМА КОЛОДА (структура) лежит в записи. Это не дубль html: из структуры
 * собираются PPTX и PDF по требованию, и без неё «скачать PPTX» через день после
 * показа означало бы второй запрос к модели за то, что уже надиктовано.
 */

/** Запись на диске = то, что уходит клиенту, плюс сама колода. */
export interface StoredDeck extends MediaDeck {
  deck: Deck;
}

const EXTENSION: Record<MediaDeckFormat, string> = {
  html: 'html',
  pdf: 'pdf',
  pptx: 'pptx',
};

/** Тип, с которым файл уходит браузеру. Список закрыт: угадывать нечего. */
export const DECK_MIME: Record<MediaDeckFormat, string> = {
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function deckDir(appDataDir: string): string {
  return join(appDataDir, 'media', 'decks');
}

/** Путь файла колоды. Имя — из ПРОВЕРЕННОГО идентификатора и закрытого списка. */
export function deckFilePath(appDataDir: string, id: string, format: MediaDeckFormat): string {
  return join(deckDir(appDataDir), `${assertId(id)}.${EXTENSION[format]}`);
}

function deckRecordPath(appDataDir: string, id: string): string {
  return join(deckDir(appDataDir), `${assertId(id)}.json`);
}

/** Сохранить колоду: файлы, затем запись. Возвращает то, что уйдёт клиенту. */
export function saveDeck(
  appDataDir: string,
  record: MediaDeck,
  deck: Deck,
  files: Partial<Record<MediaDeckFormat, Buffer>>,
): MediaDeck {
  mkdirSync(deckDir(appDataDir), { recursive: true });
  for (const [format, bytes] of Object.entries(files)) {
    if (bytes)
      writeBinaryFile(deckFilePath(appDataDir, record.id, format as MediaDeckFormat), bytes);
  }
  const stored: StoredDeck = { ...record, deck };
  writeJsonFile(deckRecordPath(appDataDir, record.id), stored);
  trimDecks(appDataDir);
  return record;
}

/** Запись о колоде вместе с её структурой; `undefined` — такой колоды нет. */
export function readDeckRecord(appDataDir: string, id: string): StoredDeck | undefined {
  const path = deckRecordPath(appDataDir, id);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as StoredDeck;
    return raw && raw.id === id && raw.deck && Array.isArray(raw.deck.slides) ? raw : undefined;
  } catch {
    // Битый `.json` — это не 500: колоды у панели нет, и сказать надо именно это.
    return undefined;
  }
}

/** Байты файла колоды. Отсутствие файла при живой записи — тоже «нет файла». */
export function readDeckFile(appDataDir: string, id: string, format: MediaDeckFormat): Buffer {
  const path = deckFilePath(appDataDir, id, format);
  if (!existsSync(path)) throw new MediaError(404, 'Файл презентации панель не нашла');
  return readFileSync(path);
}

export function hasDeckFile(appDataDir: string, id: string, format: MediaDeckFormat): boolean {
  return existsSync(deckFilePath(appDataDir, id, format));
}

/** Положить напечатанный PDF рядом: второй раз печатать то же самое незачем. */
export function cacheDeckPdf(appDataDir: string, id: string, bytes: Buffer): void {
  mkdirSync(deckDir(appDataDir), { recursive: true });
  writeBinaryFile(deckFilePath(appDataDir, id, 'pdf'), bytes);
}

/**
 * Подметание: держим последние `DECK_KEEP_FILES` колод со всеми их файлами.
 *
 * Считается по записям, как и у картинок, а вместе с записью уходят ВСЕ файлы её
 * идентификатора — их несколько, и оставленный `.pptx` от удалённой колоды был бы
 * мегабайтом без имени и без темы.
 */
export function trimDecks(appDataDir: string): void {
  const dir = deckDir(appDataDir);
  if (!existsSync(dir)) return;

  const records: Array<{ id: string; at: number }> = [];
  const files = new Map<string, string[]>();

  for (const name of readdirSync(dir)) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) continue;
    const id = name.slice(0, dot);
    if (!/^[0-9a-f]{16,32}$/.test(id)) continue;
    const full = join(dir, name);
    if (name.endsWith('.json')) {
      records.push({ id, at: statSync(full).mtimeMs });
    } else {
      files.set(id, [...(files.get(id) ?? []), full]);
    }
  }

  records.sort((left, right) => right.at - left.at);
  const kept = new Set(records.slice(0, DECK_KEEP_FILES).map((record) => record.id));

  for (const record of records) {
    if (kept.has(record.id)) continue;
    removeEntry(deckRecordPath(appDataDir, record.id));
    for (const file of files.get(record.id) ?? []) removeEntry(file);
  }
  // Файлы без записи: запись прервалась между двумя файлами, и показать такую
  // колоду нечем — ни темы, ни заголовка, ни структуры у неё нет.
  for (const [id, list] of files) {
    if (records.some((record) => record.id === id)) continue;
    for (const file of list) removeEntry(file);
  }
}
