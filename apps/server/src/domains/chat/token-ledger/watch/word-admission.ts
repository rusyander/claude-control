/**
 * R44 — итоговый текст хода признаёт пропуск: «не проверено», «пропустил гейт», «обход»,
 * «временно», «потом поправлю». Список слов — тот же, что у внешнего сторожа (WORD), на
 * английском и русском. Код в обратных кавычках и блоки кода вычищаются до поиска, той же
 * длиной: строка журнала в кавычках («`prepare_script could not run`») — цитата, не
 * признание (#g1:137 26.10, ложный WORD на строке лога).
 */

const PHRASES: RegExp[] = [
  /\bnot (?:verified|checked|tested|run)\b/,
  /\bunverified\b/,
  /\bskip(?:ped|ping)?\s+(?:the\s+|this\s+)?(?:check|test|gate|sieve|step|verification|review|hook)s?\b/,
  /\b(?:check|test|gate|sieve|step|verification|review)s?\s+(?:was\s+|were\s+|is\s+|are\s+)?skipped\b/,
  /\bwork ?around\b/,
  /\bfor now\b/,
  /\b(?:fix|do|handle|address|revisit) (?:it |this |that )?later\b/,
  /\bpre-?existing\b/,
  /\bnot related to (?:the|this|my|our) (?:change|branch|diff)\b/,
  /\bout of scope\b/,
  /\bflaky\b/,
  /\bignor(?:e|ing) (?:it|this|the (?:error|failure|warning))\b/,
  /не\s*провер/,
  /непровер/,
  /(?:^|[^а-яё])позже(?![а-яё])/,
  /потом\s+(?:сделаю|поправ|додела)/,
  /(?:пропуска[а-яё]*|пропущ[а-яё]*|пропуст[а-яё]*)\s+(?:эт[а-яё]+\s+)?(?:провер|тест|сит|шаг|гейт|ревью|хук)/,
  /(?:провер[а-яё]*|тест[а-яё]*|сит[оа]|шаг[а-яё]*|гейт[а-яё]*)\s+(?:был[аио]?\s+)?пропущ/,
  /(?:^|[^а-яё])в\s+обход/,
  /(?:^|[^а-яё])обход(?:ной|ом|им)/,
  /не\s+из-за\s+(?:ветки|правк|моих|наших)/,
  /не\s+связан[а-яё]*\s+с\s+(?:правк|ветк|изменени)/,
  /до\s+меня/,
  /уже\s+был[аио]?\s+красн/,
  /(?:^|[^а-яё])временно(?![а-яё])/,
  /заглушк/,
  /костыл/,
];

const WORD = new RegExp(PHRASES.map((phrase) => phrase.source).join('|'), 'i');
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

/** Выдержка вокруг слов: столько знаков до и после. */
const BEFORE = 70;
const AFTER = 90;

export interface Admission {
  /** Сами слова признания. */
  phrase: string;
  /** Текст вокруг них, одной строкой. */
  excerpt: string;
}

/** Признание пропуска в тексте или ничего; код в кавычках не в счёт. */
export function admissionOf(text: string): Admission | undefined {
  if (!text.trim()) return undefined;
  const blanked = text.replace(CODE, (quoted) => ' '.repeat(quoted.length));
  const match = WORD.exec(blanked);
  if (!match) return undefined;
  // Префикс «не буква» у русских слов — часть совпадения, в строку сигнала не идёт.
  const phrase = match[0].replace(/^[^\p{L}]+/u, '').trim();
  const at = match.index;
  const excerpt = text
    .slice(Math.max(0, at - BEFORE), at + match[0].length + AFTER)
    .replace(/\s+/g, ' ')
    .trim();
  return { phrase, excerpt };
}
