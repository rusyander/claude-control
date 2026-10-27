import { blockLangPattern } from '../brand.ts';
import { TASK_POINT_ID } from '../quality-floor.ts';
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
  /**
   * Прежняя строка того же сита с ДРУГИМ статусом — ставит `mergeSieveRows`, из
   * блока модели не читается. По ней судья видит переворот fail → pass без нового
   * доказательства (`flipWithoutProof`; g3 25.10: owner-4 сдан pass с тем же «красный
   * только на Windows», что неделей раньше был fail, и панель приняла).
   */
  was?: { status: SieveStatus; evidence: string };
  /**
   * Прежнее доказательство строки следа задач (`task-N`) с ТЕМ ЖЕ статусом, когда
   * новый ответ его переписал, — ставит `mergeSieveRows`, из блока модели не
   * читается. Повтор той же строки более поздним ответом метку снимает (группа
   * подтвердила). Судья доставки сверяет `at` с последним коммитом: переписанное
   * без коммита — пробел (g0 26.10: task-1285 «правка с тестами», через 13 минут
   * «код не менялся», код между ответами не трогали, и доставка приняла обе).
   */
  rewrote?: { evidence: string; at?: string };
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

/**
 * Ссылка на прогон без `run:` — как её пишут группы: `run 664941c8`, `в прогоне
 * 664941c8`, и полный номер так, как его печатают `tests-cli run` и `tests-cli record`
 * (`прогон: 53b69a2e-de7c-…`, «Прогон 4f5ba80b-9371-… записан»). g3 25.10: «в run
 * 664941c8» панель не узнала; g1 26.10: полный номер не узнавался вовсе (за восемью
 * знаками шёл дефис) — три правки строки и лишний круг `delivery`. Номер — полный UUID
 * или hex от 8 знаков (начало номера: `readRun` найдёт прогон и по нему).
 */
const LOOSE_RUN_REF =
  /(?:^|[^\p{L}\p{N}_-])(?:run|прогон\p{L}*)\s*[:#№]?\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8,64})(?![\p{L}\p{N}_-])/giu;

/** Номера из свободных форм ссылки (`LOOSE_RUN_REF`) — кандидаты, а не факт. */
export function looseRunIds(evidence: string): string[] {
  return [...new Set([...evidence.matchAll(LOOSE_RUN_REF)].map((match) => match[1]!))];
}

/**
 * Прогоны, на которые сослалось доказательство: `run:<id>` всегда, свободная
 * форма — только номер, который есть в истории блока «Тесты» копии (`exists`):
 * иначе «run 12345678» в выводе чужой команды стал бы ссылкой на несуществующий
 * прогон и держал строку.
 */
export function citedRunIds(evidence: string, exists: (id: string) => boolean): string[] {
  return [...new Set([...evidenceRunIds(evidence), ...looseRunIds(evidence).filter(exists)])];
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
/**
 * Сита, чьё доказательство обязано назвать КАЖДЫЙ отмеченный панелью файл или
 * имя (`judge.ts`: FLAGS, потребители, проверки проекта, разрушающая миграция).
 * Обычный потолок обрезал у них список: 12 полных путей не влезали в 600 знаков,
 * судья ни разу не видел строку целиком, и группа сдавала её кругами (!1072, 24.10).
 * Новое сито с именами в доказательстве — сюда же.
 */
export const NAMING_SIEVES: ReadonlySet<string> = new Set([
  'foreign-removals',
  'lockfile-sync',
  'secrets',
  'debug-leftovers',
  'committed-artifacts',
  'env-config',
  'consumers-repo-wide',
  'project-checks',
  'migration-safety',
]);
/** Потолок для них: список механики ограничен (до 80 файлов), строка — нет. */
const NAMING_EVIDENCE_MAX = 16_000;
// Строки сит, пунктов задания владельца (U2, `owner-N`) и задач (`task-N`) — в одном
// отчёте: у тикета-зонтика g9 26.10 одних пунктов приёмки и хвостов было 60+.
export const SIEVE_ROWS_MAX = 160;
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
      evidence:
        text(row.evidence, NAMING_SIEVES.has(id) ? NAMING_EVIDENCE_MAX : EVIDENCE_MAX) ?? '',
    });
    if (rows.length >= SIEVE_ROWS_MAX) break;
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
  // Блок со строками, из которых не разобрана ни одна (числовой `id`, статус `done`),
  // — не отчёт, а блок чужой схемы: он остаётся текстом и считается отклонённым (T21).
  const offered =
    (Array.isArray(sieves) ? sieves.length : 0) + (Array.isArray(learned) ? learned.length : 0);
  if (offered > 0 && rows.length === 0 && lessons.length === 0) return undefined;
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
    // Новее — по штампу, а не по месту в вызове: звено цепочки хранит свой
    // снимок отчёта, и его строки 23.10 ложились поверх сданных 24.10 (!1072).
    const prior = byId.get(row.id);
    if (prior?.at && row.at && Date.parse(row.at) < Date.parse(prior.at)) continue;
    byId.delete(row.id);
    // Прежний статус едет со строкой, пока статус не сменится снова: повтор того же
    // pass вторым ответом переворот не стирает (`flipWithoutProof`).
    const was =
      prior && prior !== row && prior.status !== row.status
        ? { status: prior.status, evidence: prior.evidence }
        : (row.was ?? prior?.was);
    const rewrote = rewroteOf(prior, row);
    if (!was && !rewrote && !row.rewrote) {
      byId.set(row.id, row);
      continue;
    }
    const merged: SieveReportRow = { ...row };
    if (rewrote) merged.rewrote = rewrote;
    else delete merged.rewrote;
    if (was) merged.was = was;
    byId.set(row.id, merged);
  }
  return [...byId.values()].slice(-SIEVE_ROWS_MAX);
}

/**
 * Метка переписанного доказательства строки следа задач (`SieveReportRow.rewrote`).
 * Только `task-N` и только при том же статусе: смену статуса судит `was`. Тот же
 * снимок ответа сливается не раз (звенья, алиасы цепочки) — подтверждением считается
 * лишь повтор строки ответом с более поздним штампом.
 */
function rewroteOf(
  prior: SieveReportRow | undefined,
  row: SieveReportRow,
): SieveReportRow['rewrote'] {
  if (!TASK_POINT_ID.test(row.id)) return undefined;
  if (!prior || prior === row) return row.rewrote;
  if (prior.status !== row.status) return undefined;
  if (prior.evidence !== row.evidence) {
    return { evidence: prior.evidence, ...(prior.at ? { at: prior.at } : {}) };
  }
  const later = Boolean(prior.at && row.at && Date.parse(row.at) > Date.parse(prior.at));
  return later ? undefined : (row.rewrote ?? prior.rewrote);
}
