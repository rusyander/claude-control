import type { Deck } from '../media-deck.ts';
import { DECK_BLOCK_LANG, parseDeckBlock } from './deck-parse.ts';
import { PICTURE_BLOCK_LANG, checkPicture } from './picture.ts';

/**
 * Что панель нашла в ответе агента: показываемый текст и принятые вложения.
 *
 * Заборы разбираются ПРАВИЛАМИ CommonMark, а не поиском строки с нашим языком, и
 * это не педантизм — три разных промаха живого разбора стоили каждый по дефекту
 * (враждебная проверка 13.09.2026):
 *
 *  - блок, ЗАКАВЫЧЕННЫЙ внутри чужого забора, — это пример, а не предложение
 *    собрать файл. Панель уже платила за это в шлюзе: 12.09.2026 настоящий
 *    `claude.exe` записал файл из блока, который модель сама пометила «не
 *    выполнять, это пример». Два противоположных правила для одной формы в одной
 *    панели держать нельзя;
 *  - незакрытый забор в ДОПИСАННОМ ответе — не «ещё печатается»: молча съесть
 *    блок и весь текст после него значит потерять слова агента без следа;
 *  - четыре кавычки, тильды и `AgentDeck:Deck` заглавными — тот же блок.
 *    CommonMark разрешает все три, а модель пишет четыре кавычки именно тогда,
 *    когда внутри могут оказаться три.
 */
export interface MediaScan {
  /** Текст ответа без разобранных блоков — то, что видно в ленте. */
  text: string;
  decks: Deck[];
  /** Годные рисунки, по одному `<svg>` на блок. */
  pictures: string[];
  /**
   * Сколько наших блоков панель НЕ приняла: не разобрались, остались
   * незакрытыми или пришли закавыченными внутри чужого забора. Такой блок
   * остаётся в ленте как есть — спрятать непонятое значит потерять слова агента,
   * — а число нужно, чтобы человек видел: решение приняла панель, а не агент.
   */
  rejected: number;
  /** Колода пришла обрезанной по потолкам панели (см. `DeckParse.truncated`). */
  truncated: boolean;
}

export interface MediaScanOptions {
  /**
   * Ответ ещё печатается. Тогда незакрытый блок прячется вместе с хвостом:
   * иначе лента показывает простыню JSON или разметку SVG, пока идёт ответ. На
   * ДОПИСАННОМ ответе (по умолчанию) такой блок остаётся текстом.
   */
  streaming?: boolean;
}

const OUR_LANGS = [DECK_BLOCK_LANG, PICTURE_BLOCK_LANG] as const;

/** Строка-забор: до трёх пробелов, три и больше кавычек или тильд, метка. */
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*?)[ \t]*$/;

interface Fence {
  marker: string;
  len: number;
  /** Первое слово метки, в нижнем регистре. Пусто — забор без языка. */
  lang: string;
}

/** Вырезать вложения из ответа. */
export function scanMediaBlocks(source: string, options: MediaScanOptions = {}): MediaScan {
  const decks: Deck[] = [];
  const pictures: string[] = [];
  let rejected = 0;
  let truncated = false;
  /** Сколько источника уже перенесено в показ. */
  let copied = 0;
  let out = '';
  let at = 0;

  while (at < source.length) {
    const end = lineEnd(source, at);
    const fence = fenceOpen(lineText(source, at, end));
    if (!fence) {
      at = end;
      continue;
    }

    const close = findClose(source, end, fence);
    if (!ours(fence.lang)) {
      // Чужой забор целиком — цитата: наш блок ВНУТРИ него остаётся примером.
      // Но молчать о нём нельзя: «карточки нет» без объяснения человек понесёт
      // чинить панель, а чинить надо промпт — ровно та же запись, что в шлюзе.
      const upto = close?.bodyEnd ?? source.length;
      rejected += quotedOurs(source, end, upto);
      at = close?.after ?? source.length;
      continue;
    }

    if (!close) {
      if (options.streaming) {
        // Блок ещё печатается: прячем его и всё после него.
        out += source.slice(copied, at);
        copied = source.length;
        break;
      }
      // Ответ дописан, а забор не закрыт: блок остаётся текстом, и панель
      // говорит, что не приняла его.
      rejected += 1;
      break;
    }

    const taken = take(fence.lang, source.slice(end, close.bodyEnd), decks, pictures);
    if (taken.ok) {
      out += source.slice(copied, at);
      copied = close.after;
      if (taken.truncated) truncated = true;
    } else {
      rejected += 1;
    }
    at = close.after;
  }

  out += source.slice(copied);
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), decks, pictures, rejected, truncated };
}

/** Забор верхнего уровня: язык, тело и где он кончается в источнике. */
export interface FencedBlock {
  lang: string;
  body: string;
  start: number;
  after: number;
}

/**
 * Заборы верхнего уровня по тем же правилам CommonMark, что у сканера: забор
 * внутри чужого забора — его содержимое, а незакрытый в список не попадает.
 * Нужны разбору ЦЕЛОГО ответа модели (`parseDeckAnswer`), где блок ищут в прозе.
 */
export function fencedBlocks(source: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let at = 0;
  while (at < source.length) {
    const end = lineEnd(source, at);
    const fence = fenceOpen(lineText(source, at, end));
    if (!fence) {
      at = end;
      continue;
    }
    const close = findClose(source, end, fence);
    if (!close) break;
    blocks.push({
      lang: fence.lang,
      body: source.slice(end, close.bodyEnd),
      start: at,
      after: close.after,
    });
    at = close.after;
  }
  return blocks;
}

function ours(lang: string): boolean {
  return (OUR_LANGS as readonly string[]).includes(lang);
}

/** Начало забора, если эта строка им является. */
function fenceOpen(line: string): Fence | undefined {
  const found = FENCE.exec(line);
  if (!found) return undefined;
  const bars = found[1] ?? '';
  const info = found[2] ?? '';
  // У забора из кавычек в метке не может быть кавычки — иначе строка с
  // однострочным кодом считалась бы открытием блока (CommonMark).
  if (bars.startsWith('`') && info.includes('`')) return undefined;
  return {
    marker: bars.slice(0, 1),
    len: bars.length,
    lang: (info.split(/[\s{]/)[0] ?? '').toLowerCase(),
  };
}

/**
 * Закрывающая строка: тот же знак, не короче открывающей и БЕЗ метки. Отсюда же
 * следует главное свойство — забор из четырёх кавычек не закрывается тремя, и
 * поэтому наш блок внутри такого забора остаётся его содержимым.
 */
function findClose(
  source: string,
  from: number,
  fence: Fence,
): { bodyEnd: number; after: number } | undefined {
  let at = from;
  while (at < source.length) {
    const end = lineEnd(source, at);
    const line = lineText(source, at, end);
    const found = FENCE.exec(line);
    const bars = found?.[1] ?? '';
    if (
      found &&
      bars.startsWith(fence.marker) &&
      bars.length >= fence.len &&
      (found[2] ?? '') === ''
    ) {
      return { bodyEnd: at, after: end };
    }
    at = end;
  }
  return undefined;
}

/** Сколько НАШИХ блоков закавычено внутри чужого забора. */
function quotedOurs(source: string, from: number, to: number): number {
  let count = 0;
  let at = from;
  while (at < to) {
    const end = lineEnd(source, at);
    const fence = fenceOpen(lineText(source, at, Math.min(end, to)));
    if (fence && ours(fence.lang)) count += 1;
    at = end;
  }
  return count;
}

function lineEnd(source: string, from: number): number {
  const nl = source.indexOf('\n', from);
  return nl < 0 ? source.length : nl + 1;
}

function lineText(source: string, from: number, end: number): string {
  return source.slice(from, end).replace(/\r?\n$/, '');
}

function take(
  lang: string,
  body: string,
  decks: Deck[],
  pictures: string[],
): { ok: boolean; truncated?: boolean } {
  if (lang === DECK_BLOCK_LANG) {
    const parsed = parseDeckBlock(body);
    if (parsed.deck) decks.push(parsed.deck);
    return { ok: Boolean(parsed.deck), truncated: parsed.truncated };
  }
  const picture = checkPicture(body);
  if (picture.svg) pictures.push(picture.svg);
  return { ok: Boolean(picture.svg) };
}
