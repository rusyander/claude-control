import { numberWordValue } from '@agentdeck/contracts/group-knobs';

/**
 * Строки скилла, похожие на счётчик прогонов: число (цифрой или словом) рядом
 * со словом, которое считает прогоны или исполнителей, — «exactly **two** review
 * subagents», «red three times», «ревью двумя агентами», «retry **once**».
 *
 * Это подсказка модели и сторож её ответа, а не выписка: без него дешёвая
 * модель на длинном скилле честно отвечала «чисел нет», пустой ответ ложился в
 * кэш, и выбор чисел у группы не появлялся, пока человек не правил скилл.
 * Кандидаты есть, а ответ пуст — это повод переспросить, а не «чисел нет».
 */

/** Сколько строк-кандидатов уходит в запрос: больше — уже шум, а не подсказка. */
export const MAX_KNOB_CANDIDATES = 16;
/** Длина строки-кандидата: столько же, сколько модели разрешено цитировать. */
const CANDIDATE_CHARS = 200;
/** Насколько далеко (в словах) от числа может стоять то, что оно считает. */
const WINDOW = 3;

const EN_COUNT = [
  /^(sub)?agents?$/,
  /^reviewers?$/,
  /^verifiers?$/,
  /^rounds?$/,
  /^lanes?$/,
  /^pass(es)?$/,
  /^times?$/,
  /^retr(y|ies)$/,
  /^attempts?$/,
  /^iterations?$/,
  /^workers?$/,
  /^(re)?runs?$/,
];
/** Русские основы: «агентами», «круга», «прохода», «попытки», «проверяющих». */
const RU_COUNT_STEMS = [
  'агент',
  'субагент',
  'сабагент',
  'подагент',
  'ревьюер',
  'проверяющ',
  'круг',
  'проход',
  'прогон',
  'попыт',
  'итерац',
  'полос',
  'воркер',
];
/**
 * «Раз» — только целым словом и сразу после числа («три раза»): иначе «разбор»
 * и «как раз … 3-й» стали бы счётчиками.
 */
const RU_COUNT_WORDS = new Set(['раз', 'раза']);
/** Кратные наречия — счётчик сами по себе: «exactly twice», «трижды». */
const SELF_COUNTING = new Set(['twice', 'thrice', 'дважды', 'трижды']);
/** «Once» чаще значит «как только»; счётчик — только рядом с повтором или в выделении. */
const RETRY_WORDS = /^(retr(y|ies|ied)|re-?run|repeat|run|повтор\p{L}*)$/u;

function countsSomething(word: string): boolean {
  if (EN_COUNT.some((pattern) => pattern.test(word))) return true;
  return RU_COUNT_STEMS.some((stem) => word.startsWith(stem));
}

function numberOf(word: string): number | undefined {
  return /^\d{1,2}$/.test(word) ? Number(word) : numberWordValue(word);
}

/**
 * «One run», «every time … one» — обычная речь, а не счётчик: единица считается
 * только рядом с исполнителями и кругами, не с «run» и «time».
 */
const PLAIN_WITH_ONE = /^((re)?runs?|times?)$/;

function near(words: readonly string[], at: number, test: (word: string) => boolean): boolean {
  const from = Math.max(0, at - WINDOW);
  const to = Math.min(words.length - 1, at + WINDOW);
  for (let i = from; i <= to; i += 1) {
    if (i !== at && test(words[i]!)) return true;
  }
  return false;
}

function lineCounts(raw: string): boolean {
  // Ссылка на раздел («§9», «§5.1») — не счётчик, хоть и цифра.
  const text = raw.replace(/§\s*\d+(\.\d+)*/g, ' ').replace(/[*_`]/g, '');
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\d]+/u)
    .filter(Boolean);
  return words.some((word, at) => {
    if (SELF_COUNTING.has(word)) return true;
    if (word === 'once') {
      return /\*\*once\*\*/i.test(raw) || near(words, at, (other) => RETRY_WORDS.test(other));
    }
    const value = numberOf(word);
    if (value === undefined) return false;
    if (RU_COUNT_WORDS.has(words[at + 1] ?? '')) return true;
    return near(
      words,
      at,
      (other) => countsSomething(other) && !(value === 1 && PLAIN_WITH_ONE.test(other)),
    );
  });
}

/** Строки-кандидаты в порядке текста, без повторов, не длиннее цитаты. */
export function knobCandidates(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line) || !lineCounts(line)) continue;
    seen.add(line);
    lines.push(line.slice(0, CANDIDATE_CHARS));
    if (lines.length >= MAX_KNOB_CANDIDATES) break;
  }
  return lines;
}
