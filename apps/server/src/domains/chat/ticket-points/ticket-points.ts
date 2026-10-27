import { TASK_POINT_ID } from '@agentdeck/contracts/quality-floor';
import type { SieveReportRow } from '@agentdeck/contracts/sieves';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { normalizeQuoteText, pointQuotes } from '../delivery-check/task-sources.ts';
import { trackerKeys } from '../tracker-keys.ts';

/**
 * Пункты тикетов против строк следа задач (аудит g5 27.10, H1). Владелец просил в
 * комментариях обеих задач PDF «Отчёт для дизайна» — перепроверка о нём ни слова: задание
 * говорило «пункты прежних задач стоят как сданы», а сданы были 7 строк на 37 пунктов, и
 * проверка доставки судила только сданные строки. Теперь пункт тикета — каждая строка
 * списка его описания и комментариев (`* `, `- `, `# `, `1. `); он покрыт, когда строка
 * `task-N` (любой статус: сделан, не сделан, не требование) цитирует его в «…». Непокрытые
 * пункты — пробел доставки и строки задания перепроверки, дословно: перечитывать тикет ради
 * них не нужно.
 */

/** Пункт тикета: ключ задачи, текст строки списка и он же для сравнения. */
export interface TicketPoint {
  key: string;
  text: string;
  norm: string;
}

/** Непокрытые пункты одной задачи — текстом строк списка. */
export interface UnmappedPoints {
  key: string;
  points: string[];
}

/** Меньше слов с буквой — подпись, а не пункт. */
const POINT_WORDS_MIN = 3;
/** Сколько знаков пункта показывать в пробеле и задании. */
const POINT_SHOWN = 160;
/** Сколько пунктов одной задачи назвать в строке пробела; остальные — счётом. */
const GAP_POINTS_MAX = 6;

/** Строка списка: `* `, `** `, `- `, `+ `, `• `, Jira `# ` (нумерованный), `1. ` / `1) `. */
const BULLET = /^\s*(?:[*\-+•]+|#+|\d{1,3}[.)])\s+(\S.*)$/u;
/** Заголовок: Jira `h2. …` или Markdown `### …` (одиночный `# ` у Jira — пункт списка). */
const HEADING = /^\s*(?:h[1-6]\.\s+|#{3,6}\s+)(.+)$/u;
/** Свои разделы файла задач панели, где строки списка — не пункты: вложения и связи. */
const PANEL_LISTS = /^(?:attachments|links)\b/iu;
/**
 * Разделы о том, что есть сейчас, а не что сделать: «Что сейчас», «Проблема», «Контекст».
 * Их строки списка описывают состояние — строка `n/a` на каждую была бы чистой тратой.
 */
const STATE_SECTION =
  /^(?:что\s+(?:есть|сейчас)|как\s+сейчас|сейчас|текущ|проблем|контекст|предыстори|current|problem|context|background|as[\s-]is)/iu;
/** Строка автора комментария (`**Имя** · время`) — новый комментарий, раздел сбрасывается. */
const COMMENT_HEAD = /^\*\*[^*]+\*\*\s+·\s/u;
/** Раздел без текста задачи: панель не прочла её или оставила указатель на прежний текст. */
const NO_TEXT = /^(?:Not read by the panel|Not updated in the tracker since the last delivery)/mu;

const clip = (text: string): string =>
  text.length > POINT_SHOWN ? `${text.slice(0, POINT_SHOWN - 1)}…` : text;

const wordCount = (text: string): number =>
  text.split(/\s+/u).filter((word) => /\p{L}/u.test(word)).length;

/** Пункты тикетов файла задач (`TASK_TICKETS` + `TASK_TICKETS_STANDING`) по порядку, без повторов. */
export function ticketPoints(tickets: string | undefined): TicketPoint[] {
  if (!tickets) return [];
  const out: TicketPoint[] = [];
  const seen = new Set<string>();
  for (const section of tickets.split(/^## /mu).slice(1)) {
    const key = trackerKeys(section.split('\n', 1)[0] ?? '')[0];
    if (!key || NO_TEXT.test(section)) continue;
    let skip = false;
    for (const line of section.split('\n').slice(1)) {
      const heading = HEADING.exec(line)?.[1]?.replace(/[*_]/gu, '').trim();
      if (heading !== undefined) {
        skip = PANEL_LISTS.test(heading) || STATE_SECTION.test(heading);
        continue;
      }
      if (COMMENT_HEAD.test(line)) {
        skip = false;
        continue;
      }
      const text = BULLET.exec(line)?.[1]?.trim();
      if (skip || !text || wordCount(text) < POINT_WORDS_MIN) continue;
      const norm = normalizeQuoteText(text);
      if (seen.has(`${key}\n${norm}`)) continue;
      seen.add(`${key}\n${norm}`);
      out.push({ key, text, norm });
    }
  }
  return out;
}

/**
 * Покрыт ли пункт строками `task-N`: цитата целиком внутри пункта (цитировали часть) или
 * пункт целиком внутри цитаты (цитировали больше). Строка, назвавшая ключ другой задачи
 * файла и не назвавшая ключ пункта, его не покрывает: одинаковый текст бывает в двух тикетах.
 */
function covered(
  point: TicketPoint,
  rows: readonly SieveReportRow[],
  fileKeys: ReadonlySet<string>,
): boolean {
  return rows.some((row) => {
    const named = trackerKeys(row.evidence).filter((key) => fileKeys.has(key));
    if (named.length > 0 && !named.includes(point.key)) return false;
    return pointQuotes(row.evidence).some(
      (parts) =>
        parts.every((part) => point.norm.includes(part)) ||
        parts.some((part) => part.includes(point.norm)),
    );
  });
}

/**
 * Пункты тикетов без строки `task-N`, которая их цитирует, — по задачам. `only` — судить
 * только эти задачи (перепроверка: задачи без изменений в трекере).
 */
export function unmappedPoints(
  tickets: string | undefined,
  rows: readonly SieveReportRow[] | undefined,
  only?: ReadonlySet<string>,
): UnmappedPoints[] {
  const points = ticketPoints(tickets);
  const fileKeys = new Set(points.map((point) => point.key));
  const taskRows = (rows ?? []).filter((row) => TASK_POINT_ID.test(row.id));
  const out = new Map<string, string[]>();
  for (const point of points) {
    if (only && !only.has(point.key)) continue;
    if (covered(point, taskRows, fileKeys)) continue;
    out.set(point.key, [...(out.get(point.key) ?? []), clip(point.text)]);
  }
  return [...out].map(([key, list]) => ({ key, points: list }));
}

/** Пробелы доставки: по строке на задачу с непокрытыми пунктами (`required` — след задач отдан). */
export function ticketPointGaps(input: {
  tickets: string | undefined;
  rows: readonly SieveReportRow[] | undefined;
  required: boolean;
}): string[] {
  if (!input.required) return [];
  return unmappedPoints(input.tickets, input.rows).map(({ key, points }) => {
    const shown = points.slice(0, GAP_POINTS_MAX).map((point) => `«${point}»`);
    const more = points.length - shown.length;
    return serverText('delivery-gap-task-point-unmapped', {
      key,
      count: String(points.length),
      points: shown.join('; ') + (more > 0 ? ` (+${more})` : ''),
    });
  });
}
