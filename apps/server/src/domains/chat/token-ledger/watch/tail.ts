import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Хвост транскриптов (субагенты сессии, а у подхваченного после перезапуска
 * прогона — и сама сессия): только новые байты, отступ на файл. Транскрипт
 * бывает в десятки мегабайт — полный разбор в цикле (как разовый замер E4)
 * здесь недопустим. Файл стал короче или сменилось его начало (переписан, а
 * не дописан) — читаем с нуля. Не чаще раза в `minIntervalMs` на файл.
 */

/** Сколько байт читать за раз: остальное — на следующем тике. */
const CHUNK_BYTES = 1024 * 1024;
/**
 * Отпечаток начала файла: файл переписан (не дописан) — начало другое, читать с нуля.
 * Вся первая строка (в ней id сессии, сообщения и время), но не меньше 1 КБ и не
 * больше 8 КБ: 64 байт у двух транскриптов совпадали — общий префикс служебной
 * строки, и подменённый файл читался бы с чужого отступа.
 */
const HEAD_MIN_BYTES = 1024;
const HEAD_MAX_BYTES = 8 * 1024;

interface FileCursor {
  offset: number;
  readAt: number;
  /** Первые байты файла на прошлом чтении. */
  head?: Buffer;
}

export class TranscriptTail {
  private readonly cursors = new Map<string, FileCursor>();

  /**
   * Запомнить концы уже лежащих файлов каталога: после перезапуска панели
   * сторож начинает с конца, без догона прошлого. Файлы, появившиеся позже,
   * читаются с начала — это новые субагенты.
   */
  prime(dir: string, now: number): void {
    for (const path of jsonlFiles(dir)) this.primeFile(path, now);
  }

  /** Запомнить конец одного файла (транскрипт сессии): прошлое не догоняется. */
  primeFile(path: string, now: number): void {
    if (this.cursors.has(path)) return;
    try {
      const size = statSync(path).size;
      this.cursors.set(path, { offset: size, readAt: now, head: readHead(path, size) });
    } catch {
      // Файла ещё нет — появится, прочтётся с начала.
    }
  }

  /**
   * Первые полные строки файла, разобранные (не дальше `bytes`): начало сессии
   * после перезапуска панели — окно её первого вызова. Курсор хвоста не трогается.
   */
  head(path: string, bytes = 256 * 1024): unknown[] {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return [];
    }
    const buffer = readBytes(path, 0, Math.min(size, bytes));
    if (!buffer) return [];
    const end = buffer.lastIndexOf(0x0a);
    if (end === -1) return [];
    return parseLines(buffer.subarray(0, end).toString('utf8'));
  }

  /** Новые полные строки всех `*.jsonl` каталога, разобранные; битые строки пропускаются. */
  read(dir: string, now: number, minIntervalMs = 30_000): Array<{ file: string; row: unknown }> {
    return jsonlFiles(dir).flatMap((path) => this.readFile(path, now, minIntervalMs));
  }

  /** Новые полные строки одного файла. */
  readFile(
    path: string,
    now: number,
    minIntervalMs = 30_000,
  ): Array<{ file: string; row: unknown }> {
    const cursor = this.cursors.get(path) ?? { offset: 0, readAt: 0 };
    if (cursor.readAt && now - cursor.readAt < minIntervalMs) return [];
    cursor.readAt = now;
    this.cursors.set(path, cursor);
    return parseLines(readNewLines(path, cursor)).map((row) => ({ file: path, row }));
  }

  /** Забыть файл или файлы каталога — сессия закончилась. Соседний каталог с тем же началом имени — чужой. */
  forget(path: string): void {
    for (const known of [...this.cursors.keys()]) {
      if (known === path || known.startsWith(`${path}${sep}`) || known.startsWith(`${path}/`)) {
        this.cursors.delete(known);
      }
    }
  }
}

function jsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Строки → разобранный JSON; не JSON — пропускаем строку, не файл. */
function parseLines(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Битая строка — пропускаем.
    }
  }
  return rows;
}

/** `length` байт с `position`; сбой чтения — `undefined`. */
function readBytes(path: string, position: number, length: number): Buffer | undefined {
  const buffer = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, length, position);
    return buffer;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readHead(path: string, size: number): Buffer | undefined {
  const buffer = readBytes(path, 0, Math.min(size, HEAD_MAX_BYTES));
  if (!buffer) return undefined;
  const lineEnd = buffer.indexOf(0x0a) + 1;
  return buffer.subarray(0, Math.max(HEAD_MIN_BYTES, lineEnd));
}

function readNewLines(path: string, cursor: FileCursor): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return '';
  }
  // Файл стал короче или начало у него другое — переписан, а не дописан: с нуля.
  const head = readHead(path, size);
  const known = cursor.head;
  const rewritten =
    known !== undefined &&
    head !== undefined &&
    !head.subarray(0, known.length).equals(known.subarray(0, head.length));
  if (size < cursor.offset || rewritten) cursor.offset = 0;
  if (head) cursor.head = head;
  if (size === cursor.offset) return '';
  const length = Math.min(size - cursor.offset, CHUNK_BYTES);
  const buffer = readBytes(path, cursor.offset, length);
  if (!buffer) return '';
  // Отступ двигается только до конца последней полной строки: недописанная
  // строка и разрезанный кусок UTF-8 дочитываются следующим разом целиком.
  const end = buffer.lastIndexOf(0x0a);
  if (end === -1) {
    // Строка длиннее куска (картинка в ответе) — пропускаем кусок, не файл.
    if (length === CHUNK_BYTES) cursor.offset += length;
    return '';
  }
  cursor.offset += end + 1;
  return buffer.subarray(0, end).toString('utf8');
}
