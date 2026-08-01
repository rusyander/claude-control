import {
  readdirSync,
  statSync,
  existsSync,
  createReadStream,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Record } from './ChatRecords.ts';

/**
 * Файл транскрипта: где он лежит и как его прочитать.
 *
 * Транскрипт — это JSON Lines, куда строки только дописываются. Файлы бывают
 * очень большими (медиана около двух мегабайт, отдельные — за сотню), поэтому
 * читать их целиком ради строки в списке нельзя: для списка берём начало и
 * конец файла. Толкованием прочитанного этот слой не занимается.
 */

/** Файл больше этого размера не читается целиком — только начало и хвост. */
export const FULL_READ_LIMIT = 4 * 1024 * 1024;
/** Сколько байт хвоста читать у большого файла. */
const TAIL_BYTES = 1024 * 1024;
/** Сколько первых строк достаточно, чтобы найти первую реплику человека. */
const HEAD_LINES = 300;

export function findTranscript(projectsDir: string, chatId: string): string | undefined {
  if (!existsSync(projectsDir)) return undefined;

  const safeId = chatId.replace(/[^a-zA-Z0-9-]/g, '');
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const candidate = join(projectsDir, entry.name, `${safeId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Разбор файла. Маленькие читаются целиком, у больших берём начало и хвост:
 * этого хватает и на заголовок, и на первую с последней репликой, а на файле
 * в сотню мегабайт полный проход занял бы секунды.
 */
export function readRecords(path: string, sizeHint: number): Record[] {
  const size = sizeHint || statSync(path).size;

  if (size <= FULL_READ_LIMIT) return parseLines(readWholeFile(path));

  return [...parseLines(readHead(path)), ...parseLines(readTail(path, size))];
}

function parseLines(text: string): Record[] {
  const records: Record[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    try {
      records.push(JSON.parse(trimmed) as Record);
    } catch {
      // Обрезанная строка на границе куска — пропускаем.
    }
  }

  return records;
}

function readWholeFile(path: string): string {
  return readChunk(path, 0, statSync(path).size);
}

function readHead(path: string): string {
  const text = readChunk(path, 0, 512 * 1024);
  return text.split('\n').slice(0, HEAD_LINES).join('\n');
}

function readTail(path: string, size: number): string {
  return readChunk(path, Math.max(0, size - TAIL_BYTES), Math.min(TAIL_BYTES, size));
}

function readChunk(path: string, position: number, length: number): string {
  const handle = openSync(path, 'r');

  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(handle, buffer, 0, length, position);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(handle);
  }
}

export function fileSessionId(path: string): string {
  return path.split(/[\\/]/).pop()?.replace('.jsonl', '') ?? '';
}

export async function* streamLines(path: string): AsyncGenerator<string> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) });
  for await (const line of lines) yield line;
}
