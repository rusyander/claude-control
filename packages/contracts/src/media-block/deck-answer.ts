import { DECK_BLOCK_LANG, parseDeckBlock, type DeckParse } from './deck-parse.ts';
import { legacyBlockLang } from '../brand.ts';
import { fencedBlocks } from './scan.ts';

/**
 * Колода из ЦЕЛОГО ответа модели — дорога контура и своего эндпоинта, где панель
 * сама просила структуру и получила текст.
 *
 * `parseDeckBlock` разбирает ТЕЛО блока и остаётся строгим: у блока агента тело
 * уже вырезано из забора. Здесь же приходит ответ как есть, а модели средней
 * руки и рассуждающие модели заворачивают JSON во фразу («Конечно! Вот…») или
 * пишут перед ним `<think>`. Отказ «ответила не колодой» об ответе, где колода
 * была, отправлял человека менять модель, которая работала (аудит MD-07).
 *
 * Порядок поиска — от самого явного к наименее явному, первая годная колода
 * побеждает:
 *  1. ответ целиком (голый JSON или один забор вокруг него);
 *  2. забор нашего языка, `json` или без языка. Забор ДРУГОГО языка — цитата,
 *     то же правило, что у сканера ответа агента (`scan.ts`);
 *  3. объект `{…}` в прозе вне заборов. Первый попавшийся объект — не
 *     обязательно колода: модель могла сначала процитировать настройку, поэтому
 *     перебираются все, а решает `parseDeckBlock`.
 */
export function parseDeckAnswer(text: string): DeckParse {
  const answer = stripReasoning(text);

  const whole = parseDeckBlock(answer);
  if (whole.deck) return whole;

  const fences = fencedBlocks(answer);
  for (const fence of fences) {
    if (!STRUCTURE_LANGS.has(fence.lang)) continue;
    const parsed = parseDeckBlock(fence.body);
    if (parsed.deck) return parsed;
  }

  for (const object of objectsIn(outsideFences(answer, fences))) {
    const parsed = parseDeckBlock(object);
    if (parsed.deck) return parsed;
  }
  return { truncated: false };
}

/**
 * Ответ без размышлений. Закрытый `<think>…</think>` вырезается; незакрытый
 * отрезает всё до конца: оборванные размышления — не ответ, даже если внутри
 * лежит черновик колоды.
 */
export function stripReasoning(text: string): string {
  const closed = text.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '');
  const open = /<(?:think|thinking)>/i.exec(closed);
  return (open ? closed.slice(0, open.index) : closed).trim();
}

/** Языки заборов, в которых лежит структура, а не цитата. */
const STRUCTURE_LANGS = new Set(['', 'json', 'jsonc', DECK_BLOCK_LANG, legacyBlockLang('deck')]);

/**
 * Сколько незакрытых `{` проверяется, прежде чем поиск сдаётся. Каждый такой
 * просматривает хвост до конца, и ответ из тысячи фигурных скобок в прозе
 * превратил бы разбор в квадратичный.
 */
const MAX_OBJECT_TRIES = 64;

function outsideFences(text: string, fences: readonly { start: number; after: number }[]): string {
  let out = '';
  let copied = 0;
  for (const fence of fences) {
    out += text.slice(copied, fence.start) + '\n';
    copied = fence.after;
  }
  return out + text.slice(copied);
}

/** Сбалансированные объекты верхнего уровня, по порядку. */
function* objectsIn(text: string): Generator<string> {
  let from = text.indexOf('{');
  let tries = 0;
  while (from >= 0 && tries < MAX_OBJECT_TRIES) {
    tries += 1;
    const end = balancedEnd(text, from);
    if (end < 0) {
      from = text.indexOf('{', from + 1);
      continue;
    }
    yield text.slice(from, end + 1);
    from = text.indexOf('{', end + 1);
  }
}

/** Конец объекта с учётом строк JSON: скобка внутри строки скобкой не считается. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}
