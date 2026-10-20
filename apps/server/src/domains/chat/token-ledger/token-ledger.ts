import type {
  SplitTokenFlag,
  SplitTokenLedger,
  SplitTokenUsage,
} from '../../../lib/app-store/app-store.types.ts';
import { normalizeProjectPath } from '../../../lib/app-store/projects.ts';

/**
 * Счёт токенов группы (E4) — постоянный датчик вместо разового скрипта.
 *
 * 12.10.2026 утечку нашли руками: группы в копиях грузили командный
 * `CLAUDE.md` и весь `.claude/rules` поверх личного слоя, и около пятой части
 * входа уходило на дубли инструкций. Здесь то же измерение, но на каждой
 * группе: следующая утечка в любом проекте видна на карточке, а не в разборе.
 *
 * Источник — транскрипт Claude: расход хода (`message.usage`), сжатия
 * (`compact_boundary`) и загруженные инструкции (вложения `instructions` и
 * `nested_memory`) лежат только там. Чужой CLI своего расхода панели не пишет,
 * и у него на карточке лишь одинаковые файлы инструкций, прочитанные с диска.
 */

/**
 * Токенов на символ инструкций: прирост контекста 73k на 162k символов правил,
 * замер 12.10.2026 на смешанном русско-английском тексте. Доля инструкций —
 * оценка по нему, не точный счёт.
 */
export const TOKENS_PER_CHAR = 73_000 / 162_000;

/** Короче — заглушка или пустой файл: совпадение таких ничего не говорит. */
const DUPLICATE_MIN_CHARS = 200;

/** Порог холодного старта относительно медианы проекта. */
const COLD_START_FACTOR = 1.5;
/** Медиана из меньшего числа групп — случайность, а не норма проекта. */
const MEDIAN_MIN_SAMPLES = 3;
const COMPACTIONS_FLAG = 3;
const INSTRUCTION_PCT_FLAG = 25;

/** Файл инструкций, как его увидела модель: путь и содержимое. */
export interface InstructionFile {
  path: string;
  content: string;
}

/** Одна сессия: сумма её ходов и загруженные инструкции. */
export interface SessionLedger {
  turns: number;
  /** Контекст первого хода — сколько стоит сам старт сессии. */
  coldStart: number;
  ctxTotal: number;
  cacheRead: number;
  compactions: number;
  /** Сколько из контекста ходов заняли инструкции (оценка по символам). */
  instructionTokens: number;
  files: InstructionFile[];
}

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' ? (value as Json) : undefined;
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

function parse(line: string): Json | undefined {
  if (!line.trim()) return undefined;
  try {
    return obj(JSON.parse(line));
  } catch {
    return undefined; // недописанная строка идущей сессии
  }
}

/** Файлы вложения инструкций; `nested_memory` несёт путь и снаружи, и внутри. */
function attachedFiles(attachment: Json): InstructionFile[] {
  if (attachment.type === 'instructions' && Array.isArray(attachment.files)) {
    return attachment.files.flatMap((item) => {
      const file = obj(item);
      const path = str(file?.path);
      return path ? [{ path, content: str(file?.content) ?? '' }] : [];
    });
  }
  if (attachment.type === 'nested_memory') {
    const content = obj(attachment.content);
    const path = str(attachment.path) ?? str(content?.path);
    return path ? [{ path, content: str(content?.content) ?? '' }] : [];
  }
  return [];
}

/**
 * Разбор транскрипта одной сессии. Ход субагента (`isSidechain`) — не ход
 * этой сессии: его контекст свой. Запись ответа повторяется на каждый блок
 * содержимого с тем же `message.id` — ход считается один раз.
 *
 * Инструкции «в контексте» с последнего сжатия: сжатие их сбрасывает, а
 * повторная загрузка того же пути до сжатия места не добавляет.
 */
export async function readSessionLedger(
  lines: AsyncIterable<string> | Iterable<string>,
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
  const turnIds = new Set<string>();
  const held = new Map<string, number>();
  const loaded = new Map<string, InstructionFile>();

  for await (const line of lines) {
    const record = parse(line);
    if (!record || record.isSidechain === true) continue;

    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      ledger.compactions += 1;
      held.clear();
      continue;
    }

    const attachment = obj(record.attachment);
    if (attachment) {
      for (const file of attachedFiles(attachment)) {
        if (!held.has(file.path)) held.set(file.path, file.content.length);
        if (!loaded.has(file.path)) loaded.set(file.path, file);
      }
      continue;
    }

    if (record.type !== 'assistant') continue;
    const message = obj(record.message);
    const usage = obj(message?.usage);
    if (!usage) continue;
    const id = str(message?.id);
    if (id) {
      if (turnIds.has(id)) continue;
      turnIds.add(id);
    }
    const cacheRead = num(usage.cache_read_input_tokens);
    const ctx = num(usage.input_tokens) + cacheRead + num(usage.cache_creation_input_tokens);
    // Ответ-заглушка CLI (ошибка API, `<synthetic>`) контекста не несёт.
    if (ctx === 0) continue;
    if (ledger.turns === 0) ledger.coldStart = ctx;
    ledger.turns += 1;
    ledger.ctxTotal += ctx;
    ledger.cacheRead += cacheRead;
    let chars = 0;
    for (const size of held.values()) chars += size;
    ledger.instructionTokens += Math.min(ctx, Math.round(chars * TOKENS_PER_CHAR));
  }

  if (ledger.turns === 0) return undefined;
  ledger.files = [...loaded.values()];
  return ledger;
}

const normalized = (content: string): string => content.replace(/\s+/g, ' ').trim();
const pathKey = normalizeProjectPath;

/**
 * Пути файлов инструкций с одинаковым содержимым под разными путями: модель
 * читает один текст дважды. Пробелы и переносы не различаются — копия с
 * другими концами строк остаётся копией.
 */
export function duplicateInstructionFiles(files: readonly InstructionFile[]): string[] {
  const byContent = new Map<string, Map<string, string>>();
  for (const file of files) {
    const text = normalized(file.content);
    if (text.length < DUPLICATE_MIN_CHARS) continue;
    const paths = byContent.get(text) ?? new Map<string, string>();
    paths.set(pathKey(file.path), file.path);
    byContent.set(text, paths);
  }
  const out: string[] = [];
  for (const paths of byContent.values()) {
    if (paths.size > 1) out.push(...paths.values());
  }
  return out.sort();
}

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

/**
 * Счёт группы по её сессиям (звено — своя сессия). Холодный старт — самый
 * тяжёлый из стартов: утечка инструкций поднимает каждый, и худший её видит.
 */
export function groupUsage(sessions: readonly SessionLedger[]): SplitTokenUsage | undefined {
  const live = sessions.filter((session) => session.turns > 0);
  if (live.length === 0) return undefined;
  let turns = 0;
  let ctxTotal = 0;
  let cacheRead = 0;
  let compactions = 0;
  let instructionTokens = 0;
  let coldStart = 0;
  for (const session of live) {
    turns += session.turns;
    ctxTotal += session.ctxTotal;
    cacheRead += session.cacheRead;
    compactions += session.compactions;
    instructionTokens += session.instructionTokens;
    coldStart = Math.max(coldStart, session.coldStart);
  }
  return {
    sessions: live.length,
    turns,
    coldStart,
    avgCtx: Math.round(ctxTotal / turns),
    compactions,
    cacheHitPct: pct(cacheRead, ctxTotal),
    instructionPct: pct(instructionTokens, ctxTotal),
  };
}

/** Медиана холодного старта по группам проекта; мало групп — нормы ещё нет. */
export function coldStartMedian(ledgers: readonly SplitTokenLedger[]): number | undefined {
  const starts = ledgers
    .map((ledger) => ledger.usage?.coldStart)
    .filter((value): value is number => typeof value === 'number' && value > 0)
    .sort((a, b) => a - b);
  if (starts.length < MEDIAN_MIN_SAMPLES) return undefined;
  const middle = Math.floor(starts.length / 2);
  return starts.length % 2 === 1
    ? (starts[middle] ?? 0)
    : Math.round(((starts[middle - 1] ?? 0) + (starts[middle] ?? 0)) / 2);
}

/** Что на карточке подсвечено: каждое — знак утечки, а не просто большой счёт. */
export function tokenFlags(ledger: SplitTokenLedger, median: number | undefined): SplitTokenFlag[] {
  const flags: SplitTokenFlag[] = [];
  const usage = ledger.usage;
  if (usage && median !== undefined && usage.coldStart > median * COLD_START_FACTOR) {
    flags.push('cold-start');
  }
  if (usage && usage.compactions >= COMPACTIONS_FLAG) flags.push('compactions');
  if (usage && usage.instructionPct > INSTRUCTION_PCT_FLAG) flags.push('instructions');
  if (ledger.duplicates?.length) flags.push('duplicate');
  return flags;
}

/**
 * Счёт группы на Claude: все транскрипты её звеньев. Нечего прочесть — нет
 * счёта, а не нулевой счёт: нули читались бы как «группа ничего не стоила».
 */
export async function measureClaudeGroup(
  transcripts: readonly string[],
  lines: (path: string) => AsyncIterable<string>,
  at: string,
): Promise<SplitTokenLedger | undefined> {
  const sessions = (
    await Promise.all(transcripts.map((path) => readSessionLedger(lines(path))))
  ).filter((session): session is SessionLedger => session !== undefined);
  const usage = groupUsage(sessions);
  const duplicates = duplicateInstructionFiles(sessions.flatMap((session) => session.files));
  if (!usage && duplicates.length === 0) return undefined;
  return { at, ...(usage ? { usage } : {}), ...(duplicates.length ? { duplicates } : {}) };
}

/**
 * Чужой CLI расхода панели не пишет — на карточке только одинаковые файлы
 * инструкций, которые он прочтёт (свой домашний и проектный).
 */
export function measureForeignGroup(
  files: readonly string[],
  read: (path: string) => string | undefined,
  at: string,
): SplitTokenLedger | undefined {
  const loaded = files.flatMap((path) => {
    const content = read(path);
    return content === undefined ? [] : [{ path, content }];
  });
  const duplicates = duplicateInstructionFiles(loaded);
  return duplicates.length > 0 ? { at, duplicates } : undefined;
}
