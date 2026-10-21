import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Хвост транскриптов (субагенты сессии, а у подхваченного после перезапуска
 * прогона — и сама сессия): только новые байты, отступ на файл. Транскрипт
 * бывает в десятки мегабайт — полный разбор в цикле (как разовый замер E4)
 * здесь недопустим. Файл стал короче (переписан) — читаем с нуля. Не чаще
 * раза в `minIntervalMs` на файл.
 */

/** Сколько байт читать за раз: остальное — на следующем тике. */
const CHUNK_BYTES = 1024 * 1024;

interface FileCursor {
  offset: number;
  readAt: number;
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
      this.cursors.set(path, { offset: statSync(path).size, readAt: now });
    } catch {
      // Файла ещё нет — появится, прочтётся с начала.
    }
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
    const out: Array<{ file: string; row: unknown }> = [];
    for (const line of readNewLines(path, cursor)) {
      try {
        out.push({ file: path, row: JSON.parse(line) });
      } catch {
        // Не JSON — пропускаем строку, не файл.
      }
    }
    return out;
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

function readNewLines(path: string, cursor: FileCursor): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size < cursor.offset) {
    cursor.offset = 0;
  }
  if (size === cursor.offset) return [];
  const length = Math.min(size - cursor.offset, CHUNK_BYTES);
  const buffer = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, length, cursor.offset);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  // Отступ двигается только до конца последней полной строки: недописанная
  // строка и разрезанный кусок UTF-8 дочитываются следующим разом целиком.
  const end = buffer.lastIndexOf(0x0a);
  if (end === -1) {
    // Строка длиннее куска (картинка в ответе) — пропускаем кусок, не файл.
    if (length === CHUNK_BYTES) cursor.offset += length;
    return [];
  }
  cursor.offset += end + 1;
  return buffer
    .subarray(0, end)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}
