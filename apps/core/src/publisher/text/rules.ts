import { findSecretSpans } from '@agentdeck/dlp/secret-mask';
import {
  codeMask,
  hexRun,
  isAlnum,
  isDigit,
  isHex,
  pathEnd,
  wholeMatches,
  wordsOf,
  type Word,
} from './scan.ts';
import type { RefusedSpan, TextSieveContext } from './text.types.ts';

/**
 * Правила отказа исходящего текста (05 §Commit shape, P62): каждое — своя функция промежутков,
 * чтобы мутант одного правила краснел ровно на его тесте. Секрет — сток P61: тот же детектор
 * `@agentdeck/dlp/secret-mask`, что маскирует журнал и бриф.
 */

/** UUID формы 8-4-4-4-12 с позиции `at`; `null` — не UUID. */
function uuidAt(text: string, at: number): { end: number; version: string } | null {
  if (isAlnum(text[at - 1]) || text[at - 1] === '-') return null;
  let i = at;
  for (const len of [8, 4, 4, 4, 12]) {
    if (i !== at) {
      if (text[i] !== '-') return null;
      i += 1;
    }
    if (hexRun(text, i) < len) return null;
    i += len;
  }
  if (isAlnum(text[i]) || text[i] === '-') return null;
  return { end: i, version: text[at + 14]! };
}

function uuids(text: string): { start: number; end: number; v7: boolean }[] {
  const out: { start: number; end: number; v7: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!isHex(text[i])) continue;
    const found = uuidAt(text, i);
    if (!found) continue;
    const variant = text[i + 19]!.toLowerCase();
    out.push({ start: i, end: found.end, v7: found.version === '7' && '89ab'.includes(variant) });
    i = found.end;
  }
  return out;
}

/** Id ядра: каждая сущность — UUIDv7 (contracts `ids.ts`), в опубликованном тексте ему не место. */
export function uuidv7Spans(text: string): RefusedSpan[] {
  return uuids(text)
    .filter((u) => u.v7)
    .map((u) => ({ rule: 'uuidv7', start: u.start, end: u.end }));
}

/**
 * Прочие формы id записей: UUID другой версии (прогоны блока «Тесты»), отпечаток sha256 (64 hex —
 * профиль, слой, артефакт) и метки `agentdeck-<слово>-<hex>`. Хеш коммита (40 hex) — публичный
 * объект форджа: ответ ревьюеру называет коммит исправления, и это не утечка.
 */
export function recordIdSpans(text: string): RefusedSpan[] {
  const out: RefusedSpan[] = uuids(text)
    .filter((u) => !u.v7)
    .map((u) => ({ rule: 'record-id', start: u.start, end: u.end }));
  for (let i = 0; i < text.length; i += 1) {
    if (!isHex(text[i]) || isAlnum(text[i - 1])) continue;
    const run = hexRun(text, i);
    if (run === 64 && !isAlnum(text[i + run]))
      out.push({ rule: 'record-id', start: i, end: i + 64 });
    i += run;
  }
  for (const word of wordsOf(text)) {
    const lower = word.text.toLowerCase();
    if (!lower.startsWith('agentdeck-')) continue;
    const tail = lower.slice(lower.lastIndexOf('-') + 1);
    if (tail.length >= 6 && hexRun(tail, 0) === tail.length && [...tail].some(isDigit))
      out.push({ rule: 'record-id', start: word.start, end: word.end });
  }
  return out;
}

const HOME_PREFIXES = ['/home/', '/Users/', '~/'];

/** Символ перед путём: начало, пробел, кавычка, скобка, `=` — не часть адреса и не буква имени. */
const opensPath = (c: string | undefined): boolean =>
  c === undefined || !(isAlnum(c) || '/.-_:~'.includes(c));

/**
 * Локальные пути машины: буква диска, домашние каталоги, `~/`, и корни ядра и копии из контекста
 * (`localRoots` — дом ядра, каталог копии: на Linux копия лежит и в `/tmp/…`).
 */
export function localPathSpans(text: string, ctx: TextSieveContext): RefusedSpan[] {
  const out: RefusedSpan[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    const drive =
      ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) &&
      text[i + 1] === ':' &&
      (text[i + 2] === '\\' || text[i + 2] === '/') &&
      !isAlnum(text[i - 1]);
    const home = HOME_PREFIXES.some((p) => text.startsWith(p, i)) && opensPath(text[i - 1]);
    if (drive || home) {
      const end = pathEnd(text, i);
      out.push({ rule: 'local-path', start: i, end });
      i = end;
    }
  }
  const lower = text.toLowerCase().split('\\').join('/');
  for (const root of ctx.localRoots) {
    const want = root.toLowerCase().split('\\').join('/');
    if (want.length < 3) continue;
    for (let at = lower.indexOf(want); at !== -1; at = lower.indexOf(want, at + 1))
      out.push({ rule: 'local-path', start: at, end: pathEnd(text, at) });
  }
  return out;
}

/** Имена компаний из `<coreHome>/publish-text.json` (G9): целым словом, без учёта регистра. */
export function companyNameSpans(text: string, ctx: TextSieveContext): RefusedSpan[] {
  return ctx.config.companyNames
    .map((name) => name.trim())
    .filter(Boolean)
    .flatMap((name) => wholeMatches(text, name))
    .map((m) => ({ rule: 'company-name', ...m }));
}

/** Слова, за которыми номер или id делают повествование о процессе (G8). */
const NUMBERED = new Set(['round', 'step', 'replay', 'раунд', 'шаг']);
const PAIRS: Record<string, readonly string[]> = {
  narrowed: ['run', 'check'],
  the: ['core'],
  core: ['step', 'steps', 'session', 'sessions', 'round', 'rounds'],
};

/** `#4`, `12` или id из hex с цифрой (`a1b2c3`) — номер шага, а не обычное слово. */
function isNumberOrId(word: string): boolean {
  const bare = word.startsWith('#') ? word.slice(1) : word;
  if (bare.length > 0 && [...bare].every(isDigit)) return true;
  return (
    bare.length >= 6 && [...bare].every((c) => isHex(c) || c === '-') && [...bare].some(isDigit)
  );
}

/** Между словами только пробелы — пара, а не два слова разных фраз. */
const adjacent = (text: string, a: Word, b: Word): boolean =>
  [...text.slice(a.end, b.start)].every((c) => c === ' ' || c === '\t');

/**
 * Слова процесса (G8) — только формы повествования вне кода: «round 3», «step 2», «replay 7»,
 * «narrowed run», «the core», «core step/session/round». Само слово `step` в прозе не судится.
 */
export function processWordSpans(text: string): RefusedSpan[] {
  const mask = codeMask(text);
  const words = wordsOf(text).filter((w) => !mask[w.start]);
  const out: RefusedSpan[] = [];
  for (let i = 0; i + 1 < words.length; i += 1) {
    const a = words[i]!;
    const b = words[i + 1]!;
    if (!adjacent(text, a, b)) continue;
    const first = a.text.toLowerCase();
    const second = b.text.toLowerCase();
    const hit = NUMBERED.has(first)
      ? isNumberOrId(b.text)
      : (PAIRS[first]?.includes(second) ?? false);
    if (hit) out.push({ rule: 'process-word', start: a.start, end: b.end });
  }
  return out;
}

/** P61 сток опубликованного текста: хеш коммита (40/64 hex) — не секрет, его судит record-id. */
export function secretSpans(text: string): RefusedSpan[] {
  return findSecretSpans(text, { keepHashes: true }).map((s) => ({ rule: 'secret', ...s }));
}
