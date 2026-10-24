import { readFileSync } from 'node:fs';
import { codexEntries, qwenEntries } from '../../../analytics/scanner/foreign.ts';
import type { SessionLedger } from '../token-ledger.ts';
import { foreignSessionsIn } from './foreign-transcript.ts';
import type { ForeignTranscriptKind } from './foreign.types.ts';

/**
 * Карточка расхода группы у Codex и Qwen Code: те же числа, что у Claude
 * (ходы, холодный старт, средний контекст, доля кэша, сжатия), но из переписки
 * самого CLI. Вызовы модели читает разбор аналитики (`codexEntries`,
 * `qwenEntries`) — карточка и страница аналитики обязаны сходиться. Инструкций
 * чужой CLI в переписку не пишет: их доля — ноль, повторы файлов считает
 * `measureForeignGroup`, как и раньше.
 */

const obj = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

function parse(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    return obj(JSON.parse(line));
  } catch {
    return undefined; // недописанная строка идущей сессии
  }
}

/** Отметка сжатия окна: Codex — `compacted`, Qwen Code — `system/chat_compression`. */
function isCompaction(kind: ForeignTranscriptKind, row: Record<string, unknown>): boolean {
  if (kind === 'codex') return row.type === 'compacted';
  return row.type === 'system' && row.subtype === 'chat_compression';
}

async function* asAsync(lines: readonly string[]): AsyncIterable<string> {
  yield* lines;
}

/** Счёт одной сессии CLI; вызовов нет — сессии для карточки нет. */
export async function readForeignSessionLedger(
  kind: ForeignTranscriptKind,
  lines: readonly string[],
): Promise<SessionLedger | undefined> {
  const ledger: SessionLedger = {
    turns: 0,
    coldStart: 0,
    ctxTotal: 0,
    cacheRead: 0,
    compactions: 0,
    instructionTokens: 0,
    files: [],
  };
  for (const line of lines) {
    const row = parse(line);
    if (row && isCompaction(kind, row)) ledger.compactions += 1;
  }
  const seen = new Set<string>();
  const entries = kind === 'codex' ? codexEntries : qwenEntries;
  for await (const entry of entries(asAsync(lines))) {
    const usage = entry.type === 'assistant' ? entry.message?.usage : undefined;
    if (!usage) continue;
    const id = entry.message?.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const ctx = (usage.input_tokens ?? 0) + cacheRead + (usage.cache_creation_input_tokens ?? 0);
    if (ctx === 0) continue;
    if (ledger.turns === 0) ledger.coldStart = ctx;
    ledger.turns += 1;
    ledger.ctxTotal += ctx;
    ledger.cacheRead += cacheRead;
  }
  return ledger.turns > 0 ? ledger : undefined;
}

function readLines(path: string): string[] | undefined {
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch {
    return undefined;
  }
}

/** Счёт всех сессий группы; непрочитанный файл пропускается. */
export async function measureForeignSessions(
  kind: ForeignTranscriptKind,
  paths: readonly string[],
  read: (path: string) => string[] | undefined = readLines,
): Promise<SessionLedger[]> {
  const out: SessionLedger[] = [];
  for (const path of paths) {
    const lines = read(path);
    const ledger = lines ? await readForeignSessionLedger(kind, lines) : undefined;
    if (ledger) out.push(ledger);
  }
  return out;
}

/**
 * Сессии группы — переписки CLI в каталоге её копии, тронутые с её старта:
 * копия у группы своя, и всё, что CLI в ней наработал, — расход группы.
 */
export function foreignGroupSessions(
  kind: ForeignTranscriptKind,
  homes: readonly string[],
  cwd: string,
  since: number,
): string[] {
  return foreignSessionsIn(kind, homes, cwd, since).map((file) => file.path);
}
