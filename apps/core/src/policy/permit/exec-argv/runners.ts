import type { Env, Stdin, Visitor } from './exec-argv.types.ts';
import { hole, isOpaque } from './marks.ts';

/**
 * Команды, которые исполняют строку или argv, переданные им аргументом (core-s2 F-03): оболочки
 * Windows (`cmd /c`, `powershell -Command/-EncodedCommand/-File -`), `script -c`, `watch`,
 * `su -c`, `sudo -s`, `flock -c`, `tmux`, `trap`, `wsl`, `runas`, `at`, `xargs`, `parallel`,
 * `find -exec`, `rg --pre`, `Start-Process`, `iex`. Каждая возвращает `true`, если команду узнала.
 */

type Aliases = ReadonlyMap<string, string>;
type Runner = (
  args: string[],
  env: Env,
  aliases: Aliases,
  depth: number,
  stdin: Stdin | undefined,
  v: Visitor,
) => void;

/** `cmd /c …`: всё после `/c` (`/k`, `/r`, слитно `/c"…"`) — одна строка cmd. */
const cmd: Runner = (args, env, aliases, depth, stdin, v) => {
  for (let i = 0; i < args.length; i++) {
    const m = /^\/([ckr])(.*)$/is.exec(args[i] as string);
    if (!m) continue;
    const text = [m[2], ...args.slice(i + 1)].filter((w) => w !== '').join(' ');
    v.script(text, 'cmd', env, aliases, depth + 1);
    return;
  }
  v.stdin(stdin, 'cmd', env, aliases, depth, 'cmd');
};

/** Параметры powershell/pwsh со значением отдельным словом (имя без регистра, по префиксу). */
const PS_VALUE_PARAMS = [
  'executionpolicy',
  'windowstyle',
  'outputformat',
  'inputformat',
  'configurationname',
  'configurationfile',
  'workingdirectory',
  'version',
  'psconsolefile',
  'settingsfile',
  'custompipename',
];
const PS_ALIASES: Record<string, string> = {
  ep: 'executionpolicy',
  ex: 'executionpolicy',
  w: 'windowstyle',
  o: 'outputformat',
  of: 'outputformat',
  if: 'inputformat',
  wd: 'workingdirectory',
  v: 'version',
  cwa: 'commandwithargs',
  ec: 'encodedcommand',
  e: 'encodedcommand',
  c: 'command',
  f: 'file',
};

function psParam(word: string): string | null {
  if (!/^[-/][A-Za-z]/.test(word)) return null;
  const name = word.slice(1).toLowerCase().replace(/:.*$/s, '');
  if (PS_ALIASES[name]) return PS_ALIASES[name] as string;
  for (const full of ['command', 'encodedcommand', 'file', 'commandwithargs', ...PS_VALUE_PARAMS]) {
    if (full.startsWith(name)) return full;
  }
  return name;
}

function decodePs(value: string): string | null {
  if (isOpaque(value) || !/^[A-Za-z0-9+/=\s]+$/.test(value)) return null;
  return Buffer.from(value, 'base64').toString('utf16le');
}

/** `powershell`/`pwsh`: `-Command`, `-EncodedCommand`, `-File -`, позиционная строка, stdin. */
const powershell: Runner = (args, env, aliases, depth, stdin, v) => {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    const param = psParam(word);
    if (param === null) {
      // Позиционный остаток — команда (Windows PowerShell; pwsh считает его файлом).
      v.script(args.slice(i).join(' '), 'ps', env, aliases, depth + 1);
      return;
    }
    if (param === 'command' || param === 'commandwithargs') {
      const rest = args.slice(i + 1);
      if (rest[0] === '-') return v.stdin(stdin, 'ps', env, aliases, depth, 'powershell');
      v.script(rest.join(' '), 'ps', env, aliases, depth + 1);
      return;
    }
    if (param === 'encodedcommand') {
      const decoded = decodePs(args[i + 1] ?? '');
      if (decoded === null) v.acc.unknown.push('powershell -EncodedCommand with an unseen value');
      else v.script(decoded, 'ps', env, aliases, depth + 1);
      return;
    }
    if (param === 'file') {
      if (args[i + 1] === '-') v.stdin(stdin, 'ps', env, aliases, depth, 'powershell');
      return;
    }
    if (PS_VALUE_PARAMS.includes(param)) i++;
  }
  v.stdin(stdin, 'ps', env, aliases, depth, 'powershell');
};

/** Короткая опция-кластер с буквой `letter`: значение — хвост кластера или следующее слово. */
function clusterValue(args: readonly string[], i: number, letter: string): string | undefined {
  const word = args[i] as string;
  const at = word.indexOf(letter);
  const tail = word.slice(at + 1);
  return tail !== '' ? tail : args[i + 1];
}

/** Строка из опции `-c`/`--command` (и слитных `-qc`); `undefined` — опции нет. */
function commandOption(args: readonly string[], letters = 'c'): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (word === '--') return undefined;
    if (word.startsWith('--command'))
      return word.includes('=') ? word.split(/=(.*)/s)[1] : args[i + 1];
    if (/^-[A-Za-z]+$/.test(word) && [...letters].some((l) => word.includes(l))) {
      const letter = [...letters].find((l) => word.includes(l)) as string;
      return clusterValue(args, i, letter);
    }
  }
  return undefined;
}

/** Позиционные слова после опций (значения указанных опций пропущены). */
function positionals(args: readonly string[], valued: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (word === '--') return [...out, ...args.slice(i + 1)];
    if (word.startsWith('-') && word !== '-') {
      if (valued.has(word)) i++;
      continue;
    }
    out.push(word);
  }
  return out;
}

const script: Runner = (args, env, aliases, depth, _stdin, v) => {
  const text = commandOption(args);
  if (text !== undefined) v.script(text, 'bash', env, aliases, depth + 1);
};

/** `watch [опции] команда…`: склеенные слова исполняет `sh -c`; `-x` — argv. */
const watch: Runner = (args, env, aliases, depth, _stdin, v) => {
  const valued = new Set(['-n', '--interval', '-q', '--equexit', '--differences']);
  let exec = false;
  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i] as string;
    if (word === '--') {
      i++;
      break;
    }
    if (!word.startsWith('-')) break;
    if (word === '-x' || word === '--exec') exec = true;
    if (valued.has(word)) i++;
  }
  const rest = args.slice(i);
  if (exec) v.argv(rest, env, aliases, depth);
  else v.script(rest.join(' '), 'bash', env, aliases, depth + 1);
};

const su: Runner = (args, env, aliases, depth, _stdin, v) => {
  const text = commandOption(args);
  if (text !== undefined) v.script(text, 'bash', env, aliases, depth + 1);
};

const SUDO_VALUED = new Set([
  '-u',
  '-g',
  '-C',
  '-h',
  '-p',
  '-U',
  '-r',
  '-t',
  '-D',
  '-R',
  '-T',
  '--user',
  '--group',
  '--close-from',
  '--host',
  '--prompt',
  '--other-user',
  '--role',
  '--type',
  '--chdir',
  '--chroot',
  '--command-timeout',
]);

/** `sudo`/`doas`/`pkexec`: argv после опций; `-s`/`-i` со словами — строка оболочки. */
const sudo: Runner = (args, env, aliases, depth, _stdin, v) => {
  let shell = false;
  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i] as string;
    if (word === '--') {
      i++;
      break;
    }
    if (!word.startsWith('-')) break;
    const [flag, inline] = word.startsWith('--') ? word.split(/=(.*)/s, 2) : [word, undefined];
    if (['--shell', '--login'].includes(flag as string)) shell = true;
    if (/^-[A-Za-z]*[si][A-Za-z]*$/.test(word) && !word.startsWith('--')) shell = true;
    if (SUDO_VALUED.has(flag as string) && inline === undefined) i++;
  }
  const rest = args.slice(i);
  if (!rest.length) return;
  if (shell) v.script(rest.join(' '), 'bash', env, aliases, depth + 1);
  v.argv(rest, env, aliases, depth);
};

/** `flock [опции] файл (-c строка | команда…)`. */
const flock: Runner = (args, env, aliases, depth, _stdin, v) => {
  const text = commandOption(args);
  if (text !== undefined) return v.script(text, 'bash', env, aliases, depth + 1);
  const rest = positionals(args, new Set(['-w', '--timeout', '-E', '--conflict-exit-code']));
  if (rest.length > 1) v.argv(rest.slice(1), env, aliases, depth);
};

/** `tmux`/`screen`: каждое позиционное слово может быть командой оболочки. */
const tmux: Runner = (args, env, aliases, depth, _stdin, v) => {
  const rest = positionals(
    args,
    new Set(['-s', '-n', '-t', '-c', '-F', '-x', '-y', '-e', '-S', '-L', '-f']),
  );
  for (const word of rest) v.script(word, 'bash', env, aliases, depth + 1);
  if (rest.length > 1) v.script(rest.join(' '), 'bash', env, aliases, depth + 1);
};

const trap: Runner = (args, env, aliases, depth, _stdin, v) => {
  const rest = positionals(args, new Set());
  if (rest[0] !== undefined) v.script(rest[0], 'bash', env, aliases, depth + 1);
};

/** `wsl [опции] команда…` — строка оболочки дистрибутива; `-e`/`--exec` — argv. */
const wsl: Runner = (args, env, aliases, depth, _stdin, v) => {
  const valued = new Set([
    '-d',
    '--distribution',
    '-u',
    '--user',
    '--cd',
    '--shell-type',
    '--distribution-id',
  ]);
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (word === '-e' || word === '--exec') return v.argv(args.slice(i + 1), env, aliases, depth);
    if (word === '--')
      return v.script(args.slice(i + 1).join(' '), 'bash', env, aliases, depth + 1);
    if (valued.has(word)) {
      i++;
      continue;
    }
    if (word.startsWith('-')) continue;
    v.script(args.slice(i).join(' '), 'bash', env, aliases, depth + 1);
    return;
  }
};

const runas: Runner = (args, env, aliases, depth, _stdin, v) => {
  const rest = args.filter((w) => !w.startsWith('/'));
  const last = rest[rest.length - 1];
  if (last !== undefined) v.script(last, 'cmd', env, aliases, depth + 1);
};

/** `at`/`batch` читают команды со stdin (`-f` — файл, остаток не виден). */
const at: Runner = (_args, env, aliases, depth, stdin, v) => {
  v.stdin(stdin, 'bash', env, aliases, depth, 'at');
};

/** npx/npm/pnpm/yarn: слово с пробелом (`-c 'git push'`, `exec -- "…"`) исполнит оболочка. */
const packageRunner: Runner = (args, env, aliases, depth, _stdin, v) => {
  for (const word of args) if (/\s/.test(word)) v.script(word, 'bash', env, aliases, depth + 1);
};

/** Слово с замещаемой строкой (`{}`) — неизвестное слово ввода. */
function substitute(words: readonly string[], replace: string | undefined): string[] {
  if (!replace) return [...words];
  return words.map((w) => (w.includes(replace) ? w.split(replace).join(hole()) : w));
}

const XARGS_VALUED = new Set([
  '-L',
  '-n',
  '-P',
  '-s',
  '-d',
  '-E',
  '-a',
  '--arg-file',
  '--delimiter',
  '--max-args',
  '--max-procs',
  '--max-lines',
  '--max-chars',
  '--eof',
  '--process-slot-var',
]);

/** `xargs`: команда + слова из stdin (дыра); `-I R` — R в словах тоже из stdin. */
const xargs: Runner = (args, env, aliases, depth, _stdin, v) => {
  let replace: string | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i] as string;
    if (word === '--') {
      i++;
      break;
    }
    if (!word.startsWith('-')) break;
    if (word === '-I') replace = args[++i];
    else if (word.startsWith('-I')) replace = word.slice(2);
    else if (word === '-i' || word === '--replace') replace = '{}';
    else if (word.startsWith('--replace=')) replace = word.slice('--replace='.length);
    else if (word.startsWith('-i')) replace = word.slice(2);
    else if (XARGS_VALUED.has(word)) i++;
  }
  const command = args.slice(i);
  const run = command.length ? command : ['echo'];
  v.argv([...substitute(run, replace), hole()], env, aliases, depth);
};

/** `parallel команда ::: ввод…`; без команды — каждое слово ввода само команда. */
const parallel: Runner = (args, env, aliases, depth, stdin, v) => {
  const sep = args.findIndex((w) => w === ':::' || w === '::::' || w === ':::+' || w === '::::+');
  const head = sep < 0 ? args : args.slice(0, sep);
  const inputs = sep < 0 ? [] : args.slice(sep + 1);
  let i = 0;
  while (i < head.length && (head[i] as string).startsWith('-')) i++;
  const command = head.slice(i);
  if (command.length) {
    v.argv([...substitute(command, '{}'), hole()], env, aliases, depth);
    return;
  }
  for (const word of inputs) v.script(word, 'bash', env, aliases, depth + 1);
  if (sep < 0) v.stdin(stdin, 'bash', env, aliases, depth, 'parallel');
};

/** `find … -exec команда {} ;` — `{}` — найденный путь. */
const find: Runner = (args, env, aliases, depth, _stdin, v) => {
  for (let i = 0; i < args.length; i++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i] as string)) continue;
    const end = args.findIndex((w, j) => j > i && (w === ';' || w === '+'));
    const command = args.slice(i + 1, end < 0 ? undefined : end);
    v.argv(substitute(command, '{}'), env, aliases, depth);
  }
};

/** `rg --pre команда` — команда с путём файла. */
const rg: Runner = (args, env, aliases, depth, _stdin, v) => {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    const value =
      word === '--pre' ? args[i + 1] : word.startsWith('--pre=') ? word.slice(6) : undefined;
    if (value !== undefined) v.argv([value, hole()], env, aliases, depth);
  }
};

/** PowerShell `iex 'строка'`. */
const iex: Runner = (args, env, aliases, depth, _stdin, v) => {
  v.script(args.join(' '), 'ps', env, aliases, depth + 1);
};

/** `Start-Process файл -ArgumentList …` (и `start` cmd с опциями `/x`). */
const startProcess: Runner = (args, env, aliases, depth, _stdin, v) => {
  const valued = new Set([
    '-workingdirectory',
    '-verb',
    '-windowstyle',
    '-redirectstandardinput',
    '-redirectstandardoutput',
    '-redirectstandarderror',
    '-credential',
    '-d',
  ]);
  let file: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    const lower = word.toLowerCase();
    if (lower === '-filepath') {
      file = args[++i];
      continue;
    }
    if (valued.has(lower) || /^\/d$/i.test(word)) {
      i++;
      continue;
    }
    if (/^-(argumentlist|args)$/.test(lower)) continue;
    if (/^[-/][A-Za-z]/.test(word)) continue;
    if (file === undefined) file = word;
    else rest.push(word);
  }
  if (file !== undefined) v.argv([file, ...rest], env, aliases, depth);
};

/** Имя команды → разбор её аргументов. */
export const RUNNERS: Record<string, Runner> = {
  cmd,
  powershell,
  pwsh: powershell,
  script,
  watch,
  su: su,
  runuser: su,
  sudo,
  doas: sudo,
  pkexec: sudo,
  flock,
  tmux,
  screen: tmux,
  trap,
  wsl,
  runas,
  at,
  batch: at,
  npx: packageRunner,
  npm: packageRunner,
  pnpm: packageRunner,
  pnpx: packageRunner,
  yarn: packageRunner,
  bunx: packageRunner,
  xargs,
  parallel,
  find,
  rg,
  iex,
  'invoke-expression': iex,
  'start-process': startProcess,
  saps: startProcess,
  start: startProcess,
};
