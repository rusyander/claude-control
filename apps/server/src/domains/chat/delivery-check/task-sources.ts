import { TASK_POINT_ID } from '@agentdeck/contracts/quality-floor';
import { EVIDENCE_MIN, type SieveReportRow } from '@agentdeck/contracts/sieves';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { trackerKeys } from '../tracker-keys.ts';

/**
 * Откуда пункт следа задач (аудит g0 26.10, F3). Задание перепроверки требовало прочесть
 * тикеты целиком; группа не прочла ни одного, сдала строки `task-N` с доказательством
 * «файл в диффе», одну выдумала (task-1285 «правка с тестами» — по описанию MR кода там не
 * было) и через 13 минут без единого коммита переписала её словами описания MR. Доставка
 * приняла обе: строку судили только по длине доказательства.
 *
 * Здесь судится строка `pass` — она утверждает, что пункт сделан:
 *
 * - ИСТОЧНИК: в доказательстве цитата пункта в «…» (или "…", “…”) — слово в слово из текста
 *   задач, который держит панель: файл задач трекера в копии (`TASK_TICKETS_FILE`), задание
 *   группы и заметки плана, описание MR. Цитаты нет — пробел `unsourced`. Цитата есть, но её
 *   нет ни в одном известном тексте — пробел `quote-unfound`; кроме случая, когда строка
 *   называет ключ задачи, текста которой у панели нет: группа читала её в трекере сама,
 *   сверить не с чем. Панель не держит ни одного текста — сверить не с чем, хватает цитаты.
 * - ПЕРЕПИСАНА БЕЗ КОММИТА: прежнее доказательство той же строки (`rewrote`, ставит
 *   `mergeSieveRows`) было с источником, а коммита после его сдачи нет — один из двух
 *   ответов неправ. Пробел, пока группа не повторит строку следующим ответом. Прежнее без
 *   источника — переписать его и просили, это не пробел. Номера прогонов, числа и время в
 *   доказательстве — не смена смысла (тот же пункт, новый прогон).
 * - МЕТКА, А НЕ ПУНКТ (g1 26.10, F5): цитата короче трёх слов — имя инструмента, кнопки, файла
 *   («qa-gl244-deepwiki: ask_wiki_question»), такое есть в тикете и без пункта. Все цитаты строки
 *   такие — пробел `quote-label`. Строка называет ключ задачи с текстом в файле задач — цитата
 *   ищется в разделе ЭТОЙ задачи (и в задании, и в описании MR), не в соседнем тикете. В описании
 *   MR пунктом считаются разделы, кроме проверок, снимков и заметок — их пишет сама группа.
 */

/** Короче — не цитата пункта, а слово («done», «ok»). */
const QUOTE_MIN = 10;
/** Меньше слов (с буквой) — метка (имя инструмента, кнопки), а не пункт задачи. */
const QUOTE_WORDS_MIN = 3;
/** Сколько знаков цитаты и доказательства показывать в строке пробела. */
const SHOWN_MAX = 160;

/** Прочие кавычки; «ёлочки» — `guillemetQuotes`: в них бывают вложенные. */
const QUOTE = /“([^“”]+)”|„([^„“”]+)[“”]|"([^"]+)"/gu;

/**
 * Цитаты в «ёлочках» со вложенными: «Кнопка «Сохранить» не работает» — одна цитата
 * целиком. Регулярка без вложенности брала только «Сохранить», короче цитаты, и пункт
 * тикета выходил «без источника» (g1 26.10: пять чтений исходников панели, чтобы понять).
 */
function guillemetQuotes(text: string): { at: number; raw: string }[] {
  const out: { at: number; raw: string }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '«') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (text[i] === '»' && depth > 0) {
      depth -= 1;
      if (depth === 0) out.push({ at: start - 1, raw: text.slice(start, i) });
    }
  }
  return out;
}

/** Текст для сравнения: регистр, ё, разметка и знаки — прочь, пробелы — по одному. */
export function normalizeQuoteText(text: string): string {
  return (
    text
      // Разложение и снятие диакритики: «ё» → «е», «é» → «e» — без русского литерала в коде
      // (`server-ru-literals`); обе стороны сравнения проходят одно и то же.
      .normalize('NFKD')
      .toLowerCase()
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  );
}

/**
 * Цитаты доказательства: части в кавычках, разрезанные по многоточию (пропуск в цитате).
 * Пустой список — цитат нет.
 */
export function quotesOf(evidence: string): string[][] {
  return quoteFinds(evidence).map((quote) => quote.parts);
}

/** Цитаты пункта, не метки: по ним строка `task-N` покрывает пункт тикета (`ticket-points`). */
export function pointQuotes(evidence: string): string[][] {
  return quoteFinds(evidence)
    .filter((quote) => !quote.label)
    .map((quote) => quote.parts);
}

/** Цитата доказательства: части для сверки и метка ли она (короче `QUOTE_WORDS_MIN` слов). */
interface QuoteFind {
  parts: string[];
  raw: string;
  label: boolean;
}

function quoteFinds(evidence: string): QuoteFind[] {
  const out: QuoteFind[] = [];
  const found = [
    ...guillemetQuotes(evidence),
    ...[...evidence.matchAll(QUOTE)].map((match) => ({
      at: match.index,
      raw: match.slice(1).find((part) => part !== undefined) ?? '',
    })),
  ].sort((a, b) => a.at - b.at);
  for (const { raw } of found) {
    const parts = raw
      .split(/…|\.\.\./u)
      .map(normalizeQuoteText)
      .filter((part) => part.length >= QUOTE_MIN);
    if (parts.length === 0) continue;
    const words = raw.split(/\s+/u).filter((word) => /\p{L}/u.test(word)).length;
    out.push({ parts, raw: raw.trim(), label: words < QUOTE_WORDS_MIN });
  }
  return out;
}

/** Что известно панели о текстах, из которых группа берёт пункты. */
export interface TaskSourceTexts {
  /** Файл задач трекера в копии (`TASK_TICKETS_FILE`); нет — не задано. */
  tickets?: string;
  /** Описание MR; не прочитано — не задано. */
  description?: string;
  /** Задание группы, заметки плана, отданные ей пункты соседей. */
  texts?: readonly string[];
}

/** Разделы файла задач с текстом (`## KEY — …`, не «Not read»): ключ → нормализованный текст. */
function ticketSections(tickets: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!tickets) return out;
  for (const section of tickets.split(/^## /mu).slice(1)) {
    const key = trackerKeys(section.split('\n', 1)[0] ?? '')[0];
    if (!key || /^Not read by the panel/mu.test(section)) continue;
    out.set(key, `${out.get(key) ?? ''}\n${normalizeQuoteText(section)}`);
  }
  return out;
}

/** Заголовок раздела описания MR, который пишет сама группа: проверки, снимки, заметки. */
const OWN_SECTION =
  /провер|прогон|гейт|тест|скриншот|снимк|замет|check|gate|verif|test|screenshot|shot|note/iu;

/** Описание MR без разделов проверок, снимков и заметок (`#`-заголовки): пункты задач — до них. */
function descriptionPoints(description: string): string {
  const kept: string[] = [];
  let own = false;
  for (const line of description.split('\n')) {
    const heading = /^\s*#{1,6}\s+(.+)$/u.exec(line)?.[1];
    if (heading !== undefined) own = OWN_SECTION.test(heading);
    if (!own) kept.push(line);
  }
  return kept.join('\n');
}

/** С чем сверяются цитаты: всё вместе, всё кроме файла задач, разделы задач по ключу. */
interface Corpus {
  all: string;
  /** Задание, заметки плана, пункты описания MR — без файла задач. */
  rest: string;
  sections: ReadonlyMap<string, string>;
}

type Sourcing = 'sourced' | 'unsourced' | { unfound: string } | { label: string };

function sourcingOf(evidence: string, corpus: Corpus | undefined): Sourcing {
  const found = quoteFinds(evidence);
  if (found.length === 0) return 'unsourced';
  const quotes = found.filter((quote) => !quote.label).map((quote) => quote.parts);
  if (quotes.length === 0) return { label: found[0]!.raw };
  if (corpus === undefined) return 'sourced';
  const keys = trackerKeys(evidence);
  // Названы задачи с текстом — цитата из ИХ разделов (или задания и описания), не из соседа.
  const scope =
    keys.length > 0 && keys.every((key) => corpus.sections.has(key))
      ? `${keys.map((key) => corpus.sections.get(key)).join('\n')}\n${corpus.rest}`
      : corpus.all;
  if (quotes.some((parts) => parts.every((part) => scope.includes(part)))) return 'sourced';
  // Ключ задачи, текста которой у панели нет: группа читала трекер сама.
  if (keys.some((key) => !corpus.sections.has(key))) return 'sourced';
  return { unfound: quotes[0]!.join(' … ') };
}

/** Смысл доказательства без номеров прогонов, чисел и времени: «тот же пункт, новый прогон». */
function meaningOf(evidence: string): string {
  // Номер прогона или коммита — hex с цифрой (слово «facade» номером не считается).
  return (
    normalizeQuoteText(
      evidence.replace(/\b(?=[0-9a-f-]*\d)[0-9a-f]{6,}(?:-[0-9a-f]{2,})*\b/giu, ' '),
    )
      .replace(/\b\d+\b/gu, ' ')
      .split(/\s+/u)
      // Однобуквенный предлог или союз смысла не меняет (g5 27.10: «go test … в inst-auth» и
      // «go test … inst-auth» — один и тот же пункт, а доставка требовала выбрать «верное»).
      .filter((word) => word.length > 1)
      .join(' ')
  );
}

const clip = (text: string): string =>
  text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX - 1)}…` : text;

/** Сколько символов общего начала оставить перед местом расхождения. */
const DIFF_CONTEXT = 40;

/**
 * «Было» и «стало» — с места первого расхождения. Обрезка с начала показывала общее начало
 * дважды, а разница лежала за многоточием (g5 27.10: «было «GOR-757 … interna…», стало
 * «GOR-757 … interna…»» — группа гадала, что сменилось).
 */
function clipPair(was: string, now: string): { was: string; now: string } {
  let at = 0;
  while (at < was.length && at < now.length && was[at] === now[at]) at++;
  const from = at > SHOWN_MAX / 2 ? at - DIFF_CONTEXT : 0;
  const cut = (text: string) => clip(from > 0 ? `…${text.slice(from)}` : text);
  return { was: cut(was), now: cut(now) };
}

/**
 * Пробелы источника строк следа задач. `required` — группе отдали след задач
 * (`taskTrace`). `headCommittedAt` — время коммита HEAD копии (ISO); нет — переписанное
 * не судится (не с чем сравнить).
 */
export function taskSourceGaps(input: {
  rows: readonly SieveReportRow[] | undefined;
  required: boolean;
  sources: TaskSourceTexts;
  headCommittedAt?: string;
}): string[] {
  if (!input.required) return [];
  const { sources } = input;
  const filled = (text: string | undefined): text is string =>
    typeof text === 'string' && text.trim().length > 0;
  const description =
    sources.description !== undefined ? descriptionPoints(sources.description) : undefined;
  const rest = [description, ...(sources.texts ?? [])].filter(filled);
  const known = [sources.tickets, ...rest].filter(filled);
  const corpus: Corpus | undefined =
    known.length > 0
      ? {
          all: normalizeQuoteText(known.join('\n')),
          rest: normalizeQuoteText(rest.join('\n')),
          sections: ticketSections(sources.tickets),
        }
      : undefined;
  const head = input.headCommittedAt ? Date.parse(input.headCommittedAt) : Number.NaN;
  const gaps: string[] = [];
  for (const row of input.rows ?? []) {
    if (!TASK_POINT_ID.test(row.id) || row.status !== 'pass') continue;
    // Пустое доказательство — свой пробел (`taskCoverageGaps`), второй не нужен.
    if (row.evidence.length < EVIDENCE_MIN) continue;
    const sourcing = sourcingOf(row.evidence, corpus);
    if (sourcing === 'unsourced') {
      gaps.push(serverText('delivery-gap-task-unsourced', { point: row.id }));
      continue;
    }
    if (sourcing !== 'sourced' && 'label' in sourcing) {
      gaps.push(
        serverText('delivery-gap-task-quote-label', { point: row.id, quote: clip(sourcing.label) }),
      );
      continue;
    }
    if (sourcing !== 'sourced') {
      gaps.push(
        serverText('delivery-gap-task-quote-unfound', {
          point: row.id,
          quote: clip(sourcing.unfound),
        }),
      );
      continue;
    }
    const before = row.rewrote;
    const at = before?.at ? Date.parse(before.at) : Number.NaN;
    if (!before || !Number.isFinite(at) || !Number.isFinite(head) || head > at) continue;
    if (sourcingOf(before.evidence, corpus) !== 'sourced') continue;
    if (meaningOf(before.evidence) === meaningOf(row.evidence)) continue;
    gaps.push(
      serverText('delivery-gap-task-rewritten', {
        point: row.id,
        ...clipPair(before.evidence, row.evidence),
      }),
    );
  }
  return gaps;
}
