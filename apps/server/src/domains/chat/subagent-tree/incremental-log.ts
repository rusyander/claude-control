import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { normalizeRecord } from '../ChatRecords/ChatRecords.ts';
import type { TranscriptRecord } from '../ChatHistory/ChatHistory.ts';

/**
 * Дочитывание транскрипта с того места, где кончилось прошлое чтение: панель
 * опрашивает прогресс каждые несколько секунд, а транскрипт долгого агента —
 * мегабайты. Строки в нём только дописываются; файл стал короче — его
 * переписали, и он читается заново.
 */

/** Что копит прочитанное: запись за записью, снимок — по требованию. */
export interface LogFold<T> {
  add(record: TranscriptRecord): void;
  snapshot(): T;
}

/** Кусок чтения файла. */
const CHUNK_BYTES = 1024 * 1024;

interface Entry<S, T> {
  size: number;
  mtimeMs: number;
  offset: number;
  carry: Buffer;
  /** Чтение начато с середины файла: первая строка оборвана — её пропустить. */
  dropPartial: boolean;
  /** Начато не с начала файла — что было раньше, не прочитано. */
  partial: boolean;
  state: S;
  snapshot: T | undefined;
}

export interface IncrementalLogOptions<S> {
  create: () => S;
  /** Сколько файлов помнить. */
  limit: number;
  /**
   * Читать впервые не дальше стольких байт от конца: главный транскрипт —
   * сотни мегабайт, а опрос прогресса не должен читать их целиком.
   */
  tailBytes?: number;
}

export class IncrementalLogs<S extends LogFold<T>, T> {
  private readonly cache = new Map<string, Entry<S, T>>();
  private readonly options: IncrementalLogOptions<S>;

  constructor(options: IncrementalLogOptions<S>) {
    this.options = options;
  }

  private fresh(size: number): Entry<S, T> {
    const tail = this.options.tailBytes;
    const start = tail !== undefined && size > tail ? size - tail : 0;
    return {
      size: 0,
      mtimeMs: 0,
      offset: start,
      carry: Buffer.alloc(0),
      dropPartial: start > 0,
      partial: start > 0,
      state: this.options.create(),
      snapshot: undefined,
    };
  }

  /** Снимок по файлу; `undefined` — файла нет или его не прочесть. */
  read(path: string): T | undefined {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      this.cache.delete(path);
      return undefined;
    }
    let entry = this.cache.get(path);
    if (entry && entry.size === stats.size && entry.mtimeMs === stats.mtimeMs && entry.snapshot) {
      return entry.snapshot;
    }
    // Файл короче прочитанного — его переписали: читаем с начала.
    if (!entry || stats.size < entry.offset) entry = this.fresh(stats.size);
    try {
      readFrom(path, entry, stats.size);
    } catch {
      return entry.snapshot;
    }
    entry.size = stats.size;
    entry.mtimeMs = stats.mtimeMs;
    entry.snapshot = entry.state.snapshot();
    this.cache.delete(path);
    this.cache.set(path, entry);
    if (this.cache.size > this.options.limit) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return entry.snapshot;
  }

  /** Накопленное по файлу — после `read`. */
  state(path: string): S | undefined {
    return this.cache.get(path)?.state;
  }

  /** Чтение начато не с начала файла. */
  isPartial(path: string): boolean {
    return this.cache.get(path)?.partial ?? false;
  }

  clear(): void {
    this.cache.clear();
  }
}

function foldLines<S extends LogFold<unknown>>(state: S, text: string): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      state.add(normalizeRecord(JSON.parse(trimmed) as TranscriptRecord));
    } catch {
      // Битая строка — пропускаем, как и остальной разбор транскриптов.
    }
  }
}

/** Дочитать файл с прошлого места. */
function readFrom<S extends LogFold<T>, T>(path: string, entry: Entry<S, T>, size: number): void {
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    while (entry.offset < size) {
      const read = readSync(
        handle,
        buffer,
        0,
        Math.min(CHUNK_BYTES, size - entry.offset),
        entry.offset,
      );
      if (read === 0) break;
      entry.offset += read;
      let chunk = Buffer.concat([entry.carry, buffer.subarray(0, read)]);
      if (entry.dropPartial) {
        const first = chunk.indexOf(0x0a);
        if (first < 0) {
          entry.carry = Buffer.alloc(0);
          continue;
        }
        chunk = chunk.subarray(first + 1);
        entry.dropPartial = false;
      }
      // Режем по последнему переводу строки в байтах: многобайтный символ на
      // границе куска не ломается, недописанная строка ждёт следующего чтения.
      const cut = chunk.lastIndexOf(0x0a);
      if (cut < 0) {
        entry.carry = Buffer.from(chunk);
        continue;
      }
      foldLines(entry.state, chunk.subarray(0, cut).toString('utf8'));
      entry.carry = Buffer.from(chunk.subarray(cut + 1));
    }
  } finally {
    closeSync(handle);
  }
}
