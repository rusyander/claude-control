/**
 * Посимвольный разбор исходящего текста. Модуль класса решений (`publish-text`): P32 запрещает
 * здесь регулярные выражения, поэтому каждая форма — явный обход символов, а граница слова —
 * буква или цифра любой письменности, а не `\b` (тот не видит кириллицу).
 */

export interface Word {
  text: string;
  start: number;
  end: number;
}

export const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

export const isHex = (c: string | undefined): boolean =>
  c !== undefined && (isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'));

/** Буква любой письменности: у неё есть регистр. Буквы без регистра в исходящем тексте редки. */
export const isLetter = (c: string | undefined): boolean =>
  c !== undefined && c.toLowerCase() !== c.toUpperCase();

export const isAlnum = (c: string | undefined): boolean => isLetter(c) || isDigit(c);

/** Символ слова для токенов: буквы, цифры, `_`, `-`, `#` (номер `#4`). */
const isWordChar = (c: string | undefined): boolean =>
  isAlnum(c) || c === '_' || c === '-' || c === '#';

/** Длина непрерывного hex с позиции `at`. */
export function hexRun(text: string, at: number): number {
  let i = at;
  while (isHex(text[i])) i += 1;
  return i - at;
}

/** Слова текста с позициями, по символам слова. */
export function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isWordChar(text[i])) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < text.length && isWordChar(text[i])) i += 1;
    out.push({ text: text.slice(start, i), start, end: i });
  }
  return out;
}

/**
 * Где в тексте код: блоки между тройными апострофами и строчные `…`. Слова процесса судятся
 * только вне кода — имя функции `runStep` или `--step 2` в примере команды не повествование.
 */
export function codeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const close = text.indexOf('```', i + 3);
      const end = close === -1 ? text.length : close + 3;
      for (let k = i; k < end; k += 1) mask[k] = true;
      i = end;
    } else if (text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      const newline = text.indexOf('\n', i + 1);
      // Незакрытый апостроф до конца строки — не код, а опечатка: судим текст как прозу.
      if (close === -1 || (newline !== -1 && newline < close)) {
        i += 1;
        continue;
      }
      for (let k = i; k <= close; k += 1) mask[k] = true;
      i = close + 1;
    } else i += 1;
  }
  return mask;
}

/** Все вхождения `needle` без учёта регистра, ограниченные не-буквой и не-цифрой с обеих сторон. */
export function wholeMatches(text: string, needle: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const hay = text.toLowerCase();
  const want = needle.toLowerCase();
  if (want.length === 0) return out;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(want, from);
    if (at === -1) return out;
    const end = at + want.length;
    if (!isAlnum(text[at - 1]) && !isAlnum(text[end])) out.push({ start: at, end });
    from = at + 1;
  }
}

/** Конец пути: первый пробел, кавычка, апостроф кода, скобка или угловая скобка. */
export function pathEnd(text: string, from: number): number {
  let i = from;
  // Набор знаков, не перевод строки: `\n` раньше `\r`, чтобы P51 не принял его за CRLF.
  while (i < text.length && !' \t\n\r"\'`()<>[]{}'.includes(text[i]!)) i += 1;
  // Точка или запятая в конце — знак препинания фразы, а не часть пути.
  while (i > from && '.,;:!?'.includes(text[i - 1]!)) i -= 1;
  return i;
}
