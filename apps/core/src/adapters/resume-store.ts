import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { samePath } from '../platform/paths.ts';
import type { SessionSpec } from './adapter.types.ts';
import type { ResumeSource, TranscriptVerdict } from './resume-store.types.ts';

/**
 * Продолжение разговора у CLI со своим домом у каждого сеанса (Codex, Goose, Kimi): сеанс ядра
 * никогда не читает и не пишет хранилище человека на месте и не запускает CLI в его доме. Разговор
 * копируется — только он и указатель, по которому CLI его находит, — в хранилище дома сеанса.
 * Источник — дом CLI прежней сессии ядра (`resume.from`, решение `continuation`) или хранилище
 * человека (разговор начат не ядром, его уже подтвердил `ownsTranscript`). Перед копией переходник
 * сверяет и id внутри транскрипта, и корень: просьба панели — только id, ей не верят.
 */

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Источник продолжения: `from` — каталог прежней сессии ядра, иначе хранилище человека. */
export function resumeSourceOf(spec: SessionSpec, home: string): ResumeSource | string {
  const from = spec.resume?.from;
  if (from === undefined) return { kind: 'human' };
  if (!isAbsolute(from)) return `resume source ${from} is not an absolute session dir`;
  // Свой каталог — не источник: копия самой себя ничего не продолжает и затёрла бы транскрипт.
  if (samePath(from, spec.dir)) return 'resume source is the session itself';
  return { kind: 'core', home: join(from, home) };
}

/** Отказ продолжить — текстом с кодом суда (`resume_*`), как его пишет дорога. */
export function resumeRefusal(cli: string, verdict: TranscriptVerdict, id: string): string {
  const code = verdict === 'unreadable' ? 'resume_unreadable' : 'resume_not_owned';
  return `${code}: ${cli} conversation ${id} ${verdict === 'foreign' ? 'belongs to another root' : verdict}`;
}

/** Вердикт суда `ownsTranscript`: `true` — свой, `false` — нет или чужой, `undefined` — не прочитать. */
export function ownedAnswer(verdict: TranscriptVerdict): boolean | undefined {
  if (verdict === 'owned') return true;
  return verdict === 'unreadable' ? undefined : false;
}

/** Корень транскрипта совпал с корнем сессии (сравнение путей ОС, регистр Windows не в счёт). */
export function rootMatches(cwd: unknown, root: string | null): boolean {
  if (root === null) return true;
  return typeof cwd === 'string' && cwd.length > 0 && samePath(cwd, root);
}

/** Первые `max` байт файла — для первой строки транскрипта (метаданные разговора). */
export function readHeadBytes(file: string, max: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Первая строка как JSON-объект; оборванная (длиннее головы) или не JSON — `null`. */
export function firstJsonLine(head: string): Record<string, unknown> | null {
  const end = head.indexOf('\n');
  if (end < 0) return null;
  try {
    const row: unknown = JSON.parse(head.slice(0, end));
    return row && typeof row === 'object' && !Array.isArray(row)
      ? (row as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Файл копии в доме сеанса: каталоги — только владельцу, как остальные файлы сеанса. */
export function writeCopy(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
}
