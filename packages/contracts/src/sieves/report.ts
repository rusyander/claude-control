import { blockLangPattern } from '../brand.ts';
import { SIEVE_CLASSES, type SieveClass } from './catalog.ts';

// ---------------------------------------------------------------- отчёт

export type SieveStatus = 'pass' | 'fail' | 'n/a';

export interface SieveReportRow {
  id: string;
  status: SieveStatus;
  evidence: string;
  /**
   * Когда панель прочла строку (ISO). Ставит панель (`stampSieveRows`), из
   * блока модели не читается: по нему судится свежесть — правка задетого ситом
   * кода после сдачи снимает зачёт (`sieve-gap-stale`).
   */
  at?: string;
}

/** Штамп прочтения строкам, сданным ЭТИМ ответом. */
export function stampSieveRows(rows: readonly SieveReportRow[], at: string): SieveReportRow[] {
  return rows.map((row) => ({ ...row, at }));
}

const RUN_REF = /(?:^|[^\w-])run:\s*([A-Za-z0-9][\w-]{5,63})/g;

/**
 * Прогоны блока «Тесты», на которые ссылается доказательство: `run:<id>` —
 * тот номер, что печатает `tests-cli run` и `tests-cli record`.
 */
export function evidenceRunIds(evidence: string): string[] {
  return [...new Set([...evidence.matchAll(RUN_REF)].map((match) => match[1]!))];
}

/** Строка выученного сита, как её пишет группа. */
export interface LearnedSieveRow {
  thread: string;
  class: SieveClass;
  scope: 'project' | 'global';
  trigger: string;
  check: string;
}

export interface SieveScan {
  text: string;
  rows: SieveReportRow[];
  learned: LearnedSieveRow[];
  rejected: number;
}

/** Потолки — отчёт уезжает в запись группы и в напоминания. */
const EVIDENCE_MAX = 600;
const ROWS_MAX = 30;
const LEARNED_MAX = 20;
export const LEARNED_TEXT_MIN = 20;
export const LEARNED_TEXT_MAX = 400;
/**
 * Короче этого — не доказательство, а «ok». Порог низкий намеренно: «n/a:
 * CSS не менялся» — законная причина, её отсекать нельзя.
 */
export const EVIDENCE_MIN = 12;

const STATUSES: readonly string[] = ['pass', 'fail', 'n/a'];

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function isClass(value: unknown): value is SieveClass {
  return typeof value === 'string' && (SIEVE_CLASSES as readonly string[]).includes(value);
}

/** Тело блока → отчёт; не JSON или не объект — `undefined`, блок остаётся текстом. */
export function parseSieveBody(
  body: string,
): { rows: SieveReportRow[]; learned: LearnedSieveRow[] } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { sieves, learned } = value as { sieves?: unknown; learned?: unknown };
  if (sieves === undefined && learned === undefined) return undefined;

  const rows: SieveReportRow[] = [];
  for (const item of Array.isArray(sieves) ? sieves : []) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = text(row.id, 80);
    const status = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
    if (!id || !STATUSES.includes(status)) continue;
    rows.push({
      id,
      status: status as SieveStatus,
      evidence: text(row.evidence, EVIDENCE_MAX) ?? '',
    });
    if (rows.length >= ROWS_MAX) break;
  }

  const lessons: LearnedSieveRow[] = [];
  for (const item of Array.isArray(learned) ? learned : []) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const thread = text(row.thread, 500);
    const trigger = text(row.trigger, LEARNED_TEXT_MAX);
    const check = text(row.check, LEARNED_TEXT_MAX);
    if (!thread || !trigger || !check) continue;
    lessons.push({
      thread,
      class: isClass(row.class) ? row.class : 'other',
      scope: row.scope === 'global' ? 'global' : 'project',
      trigger,
      check,
    });
    if (lessons.length >= LEARNED_MAX) break;
  }
  return { rows, learned: lessons };
}

const OPEN = new RegExp(`(^|\\n)[ \\t]*\`\`\`[ \\t]*${blockLangPattern('sieves')}[ \\t]*\\r?\\n`);
const CLOSE = /(^|\n)[ \t]*```[ \t]*(\r?\n|$)/;

/**
 * Вынуть блоки отчёта из текста — те же три случая, что у блока эскалации:
 * разобранный уходит, сломанный остаётся как есть, незакрытый при `streaming`
 * прячется до конца. Несколько блоков в ответе складываются: последняя строка
 * сита побеждает.
 */
export function scanSieveBlocks(source: string, options: { streaming?: boolean } = {}): SieveScan {
  const byId = new Map<string, SieveReportRow>();
  const learned: LearnedSieveRow[] = [];
  let rejected = 0;
  let rest = source;
  let out = '';
  let found = false;

  for (;;) {
    const open = OPEN.exec(rest);
    if (!open) {
      out += rest;
      break;
    }
    const lead = (open[1] ?? '').length;
    const bodyStart = open.index + open[0].length;
    out += rest.slice(0, open.index + lead);
    const close = CLOSE.exec(rest.slice(bodyStart));
    if (!close) {
      if (!options.streaming) out += rest.slice(open.index + lead);
      break;
    }
    const parsed = parseSieveBody(rest.slice(bodyStart, bodyStart + close.index));
    if (parsed) {
      found = true;
      for (const row of parsed.rows) byId.set(row.id, row);
      learned.push(...parsed.learned);
    } else {
      rejected += 1;
      out += rest.slice(open.index + lead, bodyStart + close.index + close[0].length);
    }
    rest = rest.slice(bodyStart + close.index + close[0].length);
  }

  if (!found && out === source) return { text: source, rows: [], learned: [], rejected };
  return {
    text: out.replace(/\n{3,}/g, '\n\n').trim(),
    rows: [...byId.values()],
    learned: learned.slice(0, LEARNED_MAX),
    rejected,
  };
}

/** Текст для показа человеку: без блоков отчёта. */
export function withoutSieveBlocks(source: string, options?: { streaming?: boolean }): string {
  return scanSieveBlocks(source, options).text;
}

/** Отчёт группы, накопленный по звеньям: новая строка сита заменяет прежнюю. */
export function mergeSieveRows(
  previous: readonly SieveReportRow[] | undefined,
  next: readonly SieveReportRow[],
): SieveReportRow[] {
  const byId = new Map((previous ?? []).map((row) => [row.id, row]));
  // Удалить перед записью: свежая строка встаёт в конец и не уходит под обрезку первой.
  for (const row of next) {
    byId.delete(row.id);
    byId.set(row.id, row);
  }
  return [...byId.values()].slice(-ROWS_MAX);
}
