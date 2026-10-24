import type { Word } from './shell-parse.ts';
import { DANGER, OTHER, ROUTINE, steersGit, type SegmentVerdict, type Walk } from './walk.ts';

/**
 * Встроенные команды оболочки, которые меняют её состояние: каталог,
 * переменные, их экспорт, разбор слов. Ревью 23.10 (F-15, F-16): `declare -n`,
 * `printf -v`, `mapfile`, `IFS=`, `CDPATH`, `source`, `hash -p` меняли то, что
 * исполнится или удалится, а обход считал значения прежними.
 */

/**
 * `ИМЯ=…`, `ИМЯ+=…` и элемент массива `ИМЯ[ключ]=…` (`declare -A late;
 * late[$sha]=0`): раньше элемент считался командой с неизвестным именем.
 */
export const ASSIGNMENT = /^([A-Za-z_]\w*)(?:\[[^\]=]*\])?(\+?)=/;

/** Сколько слов в начале звена — присваивания `ИМЯ=значение`. */
export function assignments(words: Word[]): number {
  const at = words.findIndex((word) => !ASSIGNMENT.test(word.text));
  return at < 0 ? words.length : at;
}

/** Значение присваивания `ИМЯ=значение` словом. */
export function assignedValue(word: Word): { name: string; append: boolean; value: Word } {
  const [, name = '', append] = ASSIGNMENT.exec(word.text) ?? [];
  const value = { ...word, text: word.text.slice(word.text.indexOf('=') + 1) };
  return { name, append: Boolean(append), value };
}

/** `ИМЯ=значение` в оболочке: значение раскрывается по уже известным переменным. */
export function assign(word: Word, walk: Walk): void {
  const { name, append, value } = assignedValue(word);
  // Элемент массива меняет не значение `$ИМЯ` целиком: дальше оно неизвестно.
  const element = word.text.startsWith(`${name}[`);
  walk.assign(name, append || element ? undefined : value);
}

/**
 * Подстановка, которую исполнит не разбор, а позднее вычисление: `'a[$(cmd)]'`
 * в `declare -i`, `let`, `[[ … -eq … ]]` — индекс массива вычисляется, и
 * команда в нём исполняется.
 */
const LATE_SUBSTITUTION = /\$\(|`/;

function lateSubstitution(word: Word, walk: Walk): boolean {
  if ((!word.dynamic || word.literalDollar) && LATE_SUBSTITUTION.test(word.text)) return true;
  const expanded = walk.expand(word);
  return !expanded.dynamic && LATE_SUBSTITUTION.test(expanded.text);
}

const DECLARERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
const QUIET_BUILTINS = new Set([
  'wait',
  'jobs',
  'ulimit',
  'umask',
  'times',
  'shift',
  'return',
  'exit',
  'break',
  'continue',
  'dirs',
]);
const FLAGS = /^[-+][a-zA-Z]+$/;

/**
 * `declare`/`export`/`local`: присваивания и экспорт. `-n` (ссылка на другое
 * имя), `-i` (значение вычисляется), `-l`/`-u` (меняют значение) — дальше
 * значения не проследить.
 */
function declareVerdict(name: string, args: Word[], walk: Walk): SegmentVerdict {
  const flags = args
    .filter((arg) => FLAGS.test(arg.text) && arg.text.startsWith('-'))
    .map((arg) => arg.text.slice(1))
    .join('');
  const evaluates = /[niaA]/.test(flags);
  if (/[nilu]/.test(flags)) walk.blind(false);
  const exports = name === 'export' || flags.includes('x');
  for (const arg of args) {
    if (FLAGS.test(arg.text)) continue;
    if (evaluates && lateSubstitution(arg, walk)) return DANGER;
    const assigned = ASSIGNMENT.exec(arg.text)?.[1];
    if (assigned) assign(arg, walk);
    else if (steersGit(arg.text)) walk.gitEnv = true;
    if (exports) walk.export(assigned ?? arg.text);
  }
  return ROUTINE;
}

/** Позиционные слова после флагов, часть которых берёт значение отдельным словом. */
function skipValued(args: Word[], valued: RegExp): Word[] {
  const rest: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (valued.test(text)) i += 1;
    else if (!text.startsWith('-')) rest.push(args[i] as Word);
  }
  return rest;
}

/** Имя переменной без индекса: `a[1]` → `a`. Индекс с подстановкой — `undefined`. */
function variableName(word: Word | undefined, walk: Walk): string | undefined {
  if (!word || lateSubstitution(word, walk)) return undefined;
  return word.text.replace(/\[.*$/, '');
}

/** `set -a`, `set -o allexport`: дальше каждое присваивание экспортируется. */
function setVerdict(args: Word[], walk: Walk): SegmentVerdict {
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (/^-[a-zA-Z]*a/.test(text)) walk.exportAll = true;
    if (text === '-o' && args[i + 1]?.text === 'allexport') walk.exportAll = true;
  }
  return ROUTINE;
}

/** Значения `for x in a b c`: только известные слова; без `in` — позиционные, не проследить. */
function loopValues(words: Word[]): string[] | undefined {
  if (words[0]?.text !== 'in') return undefined;
  const values = words.slice(1);
  return values.some((word) => word.dynamic) ? undefined : values.map((word) => word.text);
}

/** Встроенные команды оболочки, которые меняют только её состояние: каталог, переменные. */
export function builtinVerdict(raw: Word[], walk: Walk): SegmentVerdict | undefined {
  const name = raw[0]?.text ?? '';
  const args = raw.slice(1);
  if (DECLARERS.has(name)) return declareVerdict(name, args, walk);
  const words = raw.map((word) => walk.expand(word));
  const dirs = words.slice(1).filter((word) => !/^-[PLe@]+$/.test(word.text));
  // `cd` сам ничего не меняет: каждое звено дальше судится в своём каталоге.
  switch (name) {
    case 'cd':
      walk.changeDir(dirs.length === 1 ? dirs[0] : undefined);
      return ROUTINE;
    case 'pushd':
      walk.pushDir(dirs.length === 1 ? dirs[0] : undefined);
      return ROUTINE;
    case 'popd':
      walk.popDir();
      return ROUTINE;
    case 'unset':
      for (const arg of args) if (!arg.text.startsWith('-')) walk.unset(arg.text);
      return ROUTINE;
    case 'read': {
      const names = skipValued(args, /^-[adinNptu]$/);
      for (const arg of names.length > 0 ? names : [{ text: 'REPLY', dynamic: false }]) {
        walk.unset(arg.text);
      }
      return ROUTINE;
    }
    case 'for': {
      // `for pid in $(netstat … :5173 … LISTENING …)` — номера держателей порта (R-C03).
      const query = raw.length === 4 && raw[2]?.text === 'in' ? raw[3] : undefined;
      const ports = query ? walk.portQuery(query) : undefined;
      const values = ports ? [`${walk.portMark}${ports.join(',')}`] : loopValues(words.slice(2));
      if (args[0]) walk.loop(args[0].text, values);
      return ROUTINE;
    }
    case 'set':
      return setVerdict(args, walk);
    case 'shopt':
      if (args.some((arg) => arg.text === '-s') && args.some((arg) => arg.text === 'dotglob')) {
        walk.dotglob = true;
      }
      return ROUTINE;
    case 'printf': {
      if (args[0]?.text !== '-v') return undefined;
      const target = variableName(args[1], walk);
      if (!target) return DANGER;
      walk.unset(target);
      return ROUTINE;
    }
    case 'mapfile':
    case 'readarray': {
      // `-C` — обратный вызов: исполнит команду на каждой строке.
      if (args.some((arg) => /^-[a-zA-Z]*C/.test(arg.text))) return DANGER;
      const names = skipValued(args, /^-[dnOsuc]$/);
      walk.unset(variableName(names.at(-1), walk) ?? 'MAPFILE');
      return ROUTINE;
    }
    case 'getopts':
      if (args[1]) walk.unset(args[1].text);
      return ROUTINE;
    case 'let':
      if (args.some((arg) => lateSubstitution(arg, walk))) return DANGER;
      for (const arg of args) walk.unset(arg.text.replace(/[^\w].*$/, ''));
      return ROUTINE;
    case '[[':
    case '[':
    case 'test':
      return args.some((arg) => lateSubstitution(arg, walk)) ? DANGER : undefined;
    case 'source':
    case '.':
      // Сценарий из файла исполнится в этой же оболочке: что он сменит — не прочесть.
      walk.blind();
      return OTHER;
    case 'hash':
      // `hash -p ./x ls` — имя `ls` исполнит другой файл.
      return args.some((arg) => /^-[a-zA-Z]*p/.test(arg.text)) ? DANGER : ROUTINE;
    case 'enable':
      if (args.some((arg) => /^-[a-zA-Z]*f/.test(arg.text))) return DANGER;
      walk.namesUnknown = true;
      return ROUTINE;
    case 'alias':
      // `alias g=git` + `g push …` строкой ниже: оболочка Bash-инструмента
      // раскрывает псевдонимы (`expand_aliases` включён), и имя команды дальше —
      // не то, что написано (RF-BGCD, класс «имя команды из подстановки», 24.10).
      // Определение — человеку целиком: развёртку (`alias ll='rm -rf ~'`, F-15)
      // и то, где она раскроется, не проследить.
      return args.some((arg) => arg.dynamic || arg.text.includes('=')) ? DANGER : undefined;
    default:
      return QUIET_BUILTINS.has(name) ? ROUTINE : undefined;
  }
}
