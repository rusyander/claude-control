import { isInterpreter } from './interpreters.ts';
import type { Word } from './shell-parse.ts';

/**
 * Команды, которые только читают и печатают: ни файла не пишут, ни другой
 * команды не исполняют. Вход для них — данные, а не сценарий: тело heredoc у
 * `cat` или `grep` — текст, сколько бы в нём ни было «rm» и «push».
 */
const READERS = new Set([
  'tail',
  'head',
  'grep',
  'egrep',
  'fgrep',
  'wc',
  'sort',
  'uniq',
  'cat',
  'ls',
  'stat',
  'du',
  'df',
  'realpath',
  'readlink',
  'dirname',
  'basename',
  'which',
  'whoami',
  'uname',
  'id',
  'cmp',
  'comm',
  'cut',
  'tr',
  'nl',
  'rev',
  'tac',
  'column',
  'jq',
  'diff',
  'echo',
  'printf',
  'true',
  'false',
  'pwd',
  'test',
  '[',
  '[[',
  ':',
  'sleep',
  // Заголовок цикла: слова после `in` — список, подстановки в нём разобраны отдельно.
  'for',
  'dir',
  'tree',
  'file',
  'where',
  'whereis',
  'type',
  'printenv',
  'ps',
  'tasklist',
  'netstat',
  'ipconfig',
  'systeminfo',
  'hostname',
  'date',
  'nproc',
  'free',
  'uptime',
  'arch',
  'getconf',
  'locale',
  'od',
  'hexdump',
  'strings',
  'less',
  'more',
  'seq',
  'expr',
  'paste',
  'join',
  'fold',
  'fmt',
  'shuf',
  'md5sum',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'b2sum',
  'cksum',
  'awk',
  'gawk',
  'mawk',
]);

/**
 * Программа `awk` только печатает: без `system()`, `getline`, вывода в файл или
 * команду (`>`, `|`). Сравнение `$3 > 5` тоже отсеется — тогда решают правила чата.
 */
function awkReadOnly(args: Word[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (arg.text === '-F' || arg.text === '-v') {
      i += 1;
      continue;
    }
    if (/^-(F|v)\S/.test(arg.text)) continue;
    if (arg.text.startsWith('-')) return false;
    // `@include`/`@load` у gawk подгружают чужой код (F-17).
    return !arg.dynamic && !/system|getline|[|>]|@include|@load/.test(arg.text);
  }
  return false;
}

/** Флаги `sed`, при которых он только печатает: без `-i` (правка на месте) и `-f` (сценарий из файла). */
const SED_FLAG =
  /^(-[nErsuz]+|--(quiet|silent|regexp-extended|unbuffered|null-data|separate|posix|debug|sandbox))$/;
const SED_ADDRESS = String.raw`(?:\d+(?:~\d+)?|\$|/(?:[^/\\]|\\.)*/I?)`;
const SED_RANGE = new RegExp(
  String.raw`^\s*(?:${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|[+~]\d+))?\s*!?)?\s*`,
);
/** Команды `sed`, которые только печатают и листают: без `w` (запись) и `e` (исполнение). */
const SED_SIMPLE = /^(?:[pPdDnNgGhHxlz=]|[qQ]\s*\d*|\{|\})?$/;

/** `s/…/…/флаги` и `y/…/…/`: флаги — только печать и регистр, без `w файл` и `e`. */
function safeSubstitution(command: string): boolean {
  const delimiter = command[1];
  if (!delimiter || /[\s\\]/.test(delimiter)) return false;
  let fields = 0;
  let i = 2;
  for (; i < command.length && fields < 2; i += 1) {
    if (command[i] === '\\') i += 1;
    else if (command[i] === delimiter) fields += 1;
  }
  if (fields < 2) return false;
  const flags = command.slice(i).trim();
  return command[0] === 'y' ? flags === '' : /^[gpiIm\d]*$/.test(flags);
}

function safeSedScript(script: string): boolean {
  return script.split(/[;\n]/).every((part) => {
    const command = part.replace(SED_RANGE, '').trim();
    if (SED_SIMPLE.test(command)) return true;
    return (command[0] === 's' || command[0] === 'y') && safeSubstitution(command);
  });
}

/** `sed -n 257,330p файл`, `sed 's/a/b/g'` — печать; `-i`, `w`, `e` — уже нет. */
export function sedReadOnly(args: Word[]): boolean {
  const scripts: Word[] = [];
  const positional: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (arg.text === '-e' || arg.text === '--expression') {
      const script = args[i + 1];
      if (!script) return false;
      scripts.push(script);
      i += 1;
    } else if (arg.text.startsWith('--expression=')) {
      scripts.push({ ...arg, text: arg.text.slice('--expression='.length) });
    } else if (SED_FLAG.test(arg.text)) {
      continue;
    } else if (arg.text.startsWith('-') && arg.text !== '-') {
      return false;
    } else {
      positional.push(arg);
    }
  }
  if (scripts.length === 0 && positional[0]) scripts.push(positional[0]);
  return (
    scripts.length > 0 && scripts.every((script) => !script.dynamic && safeSedScript(script.text))
  );
}

/** Читающая команда, которая всё же пишет файл: `sort -o файл`, `uniq вход выход`. */
function readerWrites(name: string, args: Word[]): boolean {
  const positional = args.filter((arg) => !arg.text.startsWith('-'));
  switch (name) {
    case 'sort':
      return args.some((arg) => /^(--output|-[a-zA-Z]*o)/.test(arg.text));
    case 'uniq':
      return positional.length > 1;
    case 'date':
      return args.some((arg) => /^(-s|--set)/.test(arg.text));
    case 'hostname':
      return positional.length > 0;
    case 'tree':
      return args.some((arg) => arg.text === '-o');
    case 'shuf':
      return args.some((arg) => /^(-[a-zA-Z]*o|--output)/.test(arg.text));
    case 'ipconfig':
      // `/release`, `/renew`, `/flushdns` меняют сеть машины; печать — без ключей, `/all`, `/displaydns`.
      return !args.every((arg) => /^[/-](all|displaydns)$/i.test(arg.text));
    case 'file':
      return args.some((arg) => /^(-C|--compile)$/.test(arg.text));
    case 'awk':
    case 'gawk':
    case 'mawk':
      return !awkReadOnly(args);
    default:
      return false;
  }
}

/**
 * Читающая команда, которая исполнит программу: `sort --compress-program=./x.sh`
 * (ревью 23.10, F-17) — какую и что она сделает, по словам не узнать.
 */
export function readerRuns(words: Word[]): boolean {
  const name = (words[0]?.text ?? '').replace(/\.exe$/i, '');
  return name === 'sort' && words.slice(1).some((word) => /^--compress-prog/.test(word.text));
}

/** Только читает: печать, поиск, сверка — без записи файлов и исполнения. */
export function readsOnly(words: Word[]): boolean {
  const name = (words[0]?.text ?? '').replace(/\.exe$/i, '');
  if (name === 'sed') return sedReadOnly(words.slice(1));
  return READERS.has(name) && !readerWrites(name, words.slice(1));
}

/** Вход для звена — данные: читающая команда, `git` (`commit -F -`), звено без команды. */
export function readsInputAsData(words: Word[]): boolean {
  return words.length === 0 || words[0]?.text === 'git' || readsOnly(words);
}

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
const SHELL_FLAG = /^(-[euxvsl]+|--(noprofile|norc|posix|login))$/;

/** `bash`, `sh -eu`, `bash -o pipefail` — сценарий оболочка возьмёт со входа. */
export function isStdinShell(words: Word[]): boolean {
  const name = (words[0]?.text.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '');
  if (!POSIX_SHELLS.has(name)) return false;
  for (let i = 1; i < words.length; i += 1) {
    const arg = words[i] as Word;
    if (arg.dynamic) return false;
    if (arg.text === '-o' || arg.text === '+o') {
      if (!/^[a-z]+$/.test(words[i + 1]?.text ?? '')) return false;
      i += 1;
    } else if (!SHELL_FLAG.test(arg.text)) {
      return false;
    }
  }
  return true;
}

/**
 * Звено исполнит то, что придёт на вход: оболочка без сценария или
 * интерпретатор без программы (`python`, `node -`).
 */
export function runsInput(words: Word[]): boolean {
  if (isStdinShell(words)) return true;
  const rest = words.slice(1).map((word) => word.text);
  return (
    isInterpreter(words[0]?.text ?? '') &&
    (rest.length === 0 || (rest.length === 1 && rest[0] === '-'))
  );
}
