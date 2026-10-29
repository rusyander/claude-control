import { HOME_ENV_NAMES } from '../../../platform/os-kind.ts';

/**
 * Дыры в словах (core-s2 F-02): часть слова, значение которой разбор не знает, — переменная,
 * подстановка, маска файлов, раскрытие скобок. Дыра хранится в слове меткой `\0<тег>\1`
 * (в argv таких байтов не бывает): `$NAME` — переменная (её значение подставит обход, если
 * строка его задала), `<` — подстановка процесса, пусто — неизвестно что. Слово с дырой
 * совпадает с запрещённым префиксом «может быть»: судья такое не разрешает (fail-closed).
 */

const OPEN = '\u0000';
const CLOSE = '\u0001';
// eslint-disable-next-line no-control-regex -- метки дыр и есть управляющие знаки \0 и \1
const HOLE = /\u0000([^\u0001]*)\u0001/g;
// eslint-disable-next-line no-control-regex -- метки дыр и есть управляющие знаки \0 и \1
const ONLY_HOLES = /^(?:\u0000[^\u0001]*\u0001)+$/;

/** Переменные, которые значат домашний каталог (имена без регистра; `ENV:` — PowerShell). */
const HOME_VARS = new Set(HOME_ENV_NAMES.flatMap((name) => [name, `ENV:${name}`]));

export function hole(tag = ''): string {
  return `${OPEN}${tag}${CLOSE}`;
}

export function variable(name: string): string {
  return hole(`$${name}`);
}

export const PROCESS_SUBSTITUTION = hole('<');

export function isOpaque(word: string): boolean {
  return word.includes(OPEN);
}

/** Слово — подстановка процесса целиком: путь к выходу команды, не к файлу. */
export function isProcessSubstitution(word: string): boolean {
  return word.includes(PROCESS_SUBSTITUTION);
}

/** Слово из одних дыр: может раскрыться в ноль, одно или несколько слов. */
export function onlyHoles(word: string): boolean {
  return ONLY_HOLES.test(word);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Слово как регулярное выражение: дыра — любой текст. */
export function wordPattern(word: string, flags = ''): RegExp {
  let source = '';
  let last = 0;
  for (const m of word.matchAll(HOLE)) {
    source += `${escape(word.slice(last, m.index))}[\\s\\S]*`;
    last = (m.index ?? 0) + m[0].length;
  }
  source += escape(word.slice(last));
  return new RegExp(`^${source}$`, flags);
}

/** Имя исполняемого файла без пути, расширения Windows и регистра: `C:\…\git.exe` → `git`. */
export function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  // Win32 срезает хвостовые точки и пробелы имени: `git.exe.` — тот же git.exe.
  return base
    .toLowerCase()
    .replace(/[. ]+$/, '')
    .replace(/\.(exe|cmd|bat|com)$/, '');
}

/**
 * Подставляет известные значения переменных: заданные строкой (`p=push; git $p`) и домашний
 * каталог. Слово из одной переменной без кавычек делится по пробелам, как его поделит оболочка.
 */
export function expandWord(
  word: string,
  env: ReadonlyMap<string, string>,
  home: string | undefined,
): string[] {
  if (!isOpaque(word)) return [word];
  let known = true;
  const out = word.replace(HOLE, (all, tag: string) => {
    if (!tag.startsWith('$')) {
      known = false;
      return all;
    }
    const name = tag.slice(1);
    const value =
      env.get(name) ?? (home !== undefined && HOME_VARS.has(name.toUpperCase()) ? home : undefined);
    if (value === undefined) {
      known = false;
      return all;
    }
    return value;
  });
  const single = word.match(HOLE)?.length === 1 && onlyHoles(word);
  if (known && single && /\s/.test(out)) return out.split(/\s+/).filter(Boolean);
  return [out];
}

export type PrefixMatch = 'yes' | 'maybe' | 'no';

/**
 * Совпадает ли форма с префиксом argv. Слово с дырой может оказаться любым словом, а слово
 * из одних дыр — и несколькими словами, и ни одним: тогда ответ «может быть».
 */
export function matchPrefix(form: readonly string[], prefix: readonly string[]): PrefixMatch {
  if (prefix.length === 0) return 'no';
  let maybe = false;
  const walk = (fi: number, pi: number): boolean => {
    if (pi === prefix.length) return true;
    const word = form[fi];
    if (word === undefined) return false;
    if (!isOpaque(word)) return word === prefix[pi] && walk(fi + 1, pi + 1);
    const re = wordPattern(word);
    if (onlyHoles(word) && walk(fi + 1, pi)) return (maybe = true);
    for (let k = pi + 1; k <= prefix.length; k++) {
      if (re.test(prefix.slice(pi, k).join(' ')) && walk(fi + 1, k)) return (maybe = true);
    }
    return false;
  };
  if (!walk(0, 0)) return 'no';
  return maybe ? 'maybe' : 'yes';
}
