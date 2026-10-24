import { parse, UNPARSED, type Segment, type Word } from './shell-parse.ts';
import type { Unwrapped } from './wrappers.types.ts';

/**
 * `env [ключи] [ИМЯ=знач…] команда` — разбор ключей так, как их читает GNU env
 * (getopt с `+`: ключи до первого не-ключа). Раньше разбор видел только
 * отдельные `-C`/`-S`, и слитые формы (`-S'git push origin main'`, `-iS…`,
 * `--split-string=…`, `-C/c/Users`) проходили сами: строка `-S` исполнялась
 * мимо суда, `-C` уводил команду из копии, а снимок брался с копии (ревью
 * 23.10, R-01, R-04).
 */

/** Длинные ключи env: со значением (`required`), с необязательным (`optional`), без. */
const LONG = new Map<string, 'none' | 'required' | 'optional'>([
  ['ignore-environment', 'none'],
  ['null', 'none'],
  ['unset', 'required'],
  ['chdir', 'required'],
  ['split-string', 'required'],
  ['debug', 'none'],
  ['default-signal', 'optional'],
  ['ignore-signal', 'optional'],
  ['block-signal', 'optional'],
  ['list-signal-handling', 'none'],
  ['help', 'none'],
  ['version', 'none'],
]);

/** Длинный ключ по имени или однозначному началу (`--ch` = `--chdir`), как getopt_long. */
function longName(text: string): string | undefined {
  if (LONG.has(text)) return text;
  const matches = [...LONG.keys()].filter((name) => name.startsWith(text));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Строка `-S` — новые слова команды: GNU env делит её сам и продолжает разбор
 * ключей по ним. Делим разбором оболочки; `\` (у env `\_` — разделитель, `\c`
 * — конец строки) и всё, что не одно простое звено, — не прочесть, человеку.
 */
function splitWords(value: Word): Word[] | undefined {
  if (value.dynamic || value.text.includes('\\')) return undefined;
  const steps = parse(value.text);
  if (steps === UNPARSED) return undefined;
  // Подоболочка, `{ …; }`, слепое место — символы среди шагов: уже не одно звено.
  const segments = steps.filter((step): step is Segment => typeof step === 'object');
  if (segments.length > 1 || steps.length !== segments.length) return undefined;
  const [only] = segments;
  if (!only) return [];
  if (only.redirects.length > 0 || only.inputs.length > 0) return undefined;
  return only.words;
}

/** Строки `-S` в строках `-S`: глубже — человеку. */
const MAX_SPLITS = 4;

const missing: Word = { text: '', dynamic: true };

/**
 * Снять `env`. `cwd` — каталог из `-C`/`--chdir` (последний побеждает, как у
 * env). `undefined` — ключ, которого разбор не знает: такой env откажется
 * запускать команду, звено судится целиком, как раньше.
 */
export function envUnwrap(args: Word[], cwd?: Word, depth = 0): Unwrapped | undefined {
  let dir = cwd;
  let i = 0;
  // Значение ключа: слитое (`-Cdir`, `--chdir=dir`) или следующее слово.
  const valueAt = (attached: string | undefined, dynamic: boolean): Word => {
    if (attached !== undefined) return { text: attached, dynamic };
    i += 1;
    return args[i] ?? missing;
  };
  const split = (value: Word): Unwrapped | undefined => {
    const words = depth < MAX_SPLITS ? splitWords(value) : undefined;
    if (!words) return { kind: 'danger' };
    return envUnwrap([...words, ...args.slice(i + 1)], dir, depth + 1);
  };
  for (; i < args.length; i += 1) {
    const word = args[i] as Word;
    const text = word.text;
    if (text === '--') {
      i += 1;
      break;
    }
    if (text === '-') continue;
    if (text.startsWith('--')) {
      const at = text.indexOf('=');
      const name = longName(text.slice(2, at < 0 ? undefined : at));
      if (name === undefined) return undefined;
      if (name === 'help' || name === 'version') return { kind: 'reader' };
      const kind = LONG.get(name);
      const attached = at < 0 ? undefined : text.slice(at + 1);
      if (kind === 'none' && attached !== undefined) return undefined;
      if (kind !== 'required') continue;
      const value = valueAt(attached, word.dynamic);
      if (name === 'chdir') dir = value;
      if (name === 'split-string') return split(value);
      continue;
    }
    if (!text.startsWith('-') || text.length < 2) break;
    // Связка коротких ключей: `-iv`, `-iuX`, `-iC/c/x`, `-vS'…'` — ключ со
    // значением забирает остаток слова или следующее слово.
    for (let j = 1; j < text.length; j += 1) {
      const letter = text[j] as string;
      if (letter === 'i' || letter === '0' || letter === 'v') continue;
      if (letter !== 'u' && letter !== 'C' && letter !== 'S') return undefined;
      const rest = text.slice(j + 1);
      const value = valueAt(rest === '' ? undefined : rest, word.dynamic);
      if (letter === 'C') dir = value;
      if (letter === 'S') return split(value);
      break;
    }
  }
  const words = args.slice(i);
  if (words.length === 0) return { kind: 'reader' };
  return { kind: 'command', words, ...(dir ? { cwd: dir } : {}) };
}
