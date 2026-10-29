import { parseBash } from './bash.ts';
import type {
  AnalyzeOptions,
  Dialect,
  Env,
  ExecAnalysis,
  ParsedScript,
  Stdin,
  Visitor,
} from './exec-argv.types.ts';
import { parseCmd, parsePowerShell } from './foreign.ts';
import { visitGit } from './git.ts';
import { commandName, expandWord, isOpaque, isProcessSubstitution, onlyHoles } from './marks.ts';
import { RUNNERS } from './runners.ts';

/**
 * Обход строки так, как её исполнит оболочка (P28, core-s2 F-01…F-03). Глубина растёт на каждый
 * вложенный скрипт (подстановка, `sh -c`, `eval`…), не на команду; предел глубины, число форм и
 * предохранитель снятия обёрток — запись в `unknown`: судья такое не разрешает (fail-closed).
 */

const MAX_DEPTH = 16;
const MAX_FORMS = 8192;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/** Обёртки: имя → опции, которым значение идёт отдельным словом; `skip` — позиционных до команды. */
const WRAPPERS: Record<string, { valued: readonly string[]; skip?: number }> = {
  env: { valued: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  command: { valued: [] },
  builtin: { valued: [] },
  exec: { valued: ['-a'] },
  nohup: { valued: [] },
  setsid: { valued: [] },
  nice: { valued: ['-n', '--adjustment'] },
  time: { valued: ['-f', '--format', '-o', '--output'] },
  timeout: { valued: ['-k', '--kill-after', '-s', '--signal'], skip: 1 },
  stdbuf: { valued: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  ionice: { valued: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '-u'] },
  chrt: { valued: [], skip: 1 },
  taskset: { valued: [], skip: 1 },
  numactl: {
    valued: [
      '-N',
      '-m',
      '-C',
      '-p',
      '-i',
      '-l',
      '--cpunodebind',
      '--membind',
      '--physcpubind',
      '--interleave',
      '--preferred',
    ],
  },
  prlimit: { valued: ['-p', '--pid'] },
  strace: {
    valued: ['-o', '-e', '-p', '-s', '-u', '-a', '-b', '-E', '-I', '-O', '-S', '-X', '-P'],
  },
  ltrace: { valued: ['-o', '-e', '-p', '-s', '-u', '-a', '-n', '-l', '-x', '-L', '-A', '-D'] },
  valgrind: { valued: [] },
  firejail: { valued: [] },
  bwrap: { valued: [] },
  proot: { valued: ['-r', '-b', '-w', '-q', '-k'] },
  fakeroot: { valued: ['-l', '--lib', '--faked', '-s', '-i'] },
  'xvfb-run': {
    valued: [
      '-n',
      '--server-num',
      '-s',
      '--server-args',
      '-f',
      '--auth-file',
      '-e',
      '--error-file',
      '-p',
      '--xauth-protocol',
      '-w',
      '--wait',
      '-l',
    ],
  },
  'dbus-run-session': { valued: ['--config-file', '--dbus-daemon'] },
  winpty: { valued: [] },
  caffeinate: { valued: ['-t', '-w'] },
  chroot: { valued: ['--userspec', '--groups'], skip: 1 },
  unshare: { valued: ['-S', '--setuid', '-G', '--setgid', '-R', '--root', '-w', '--wd'] },
  nsenter: { valued: ['-t', '--target', '-S', '--setuid', '-G', '--setgid', '-r', '-w'] },
  'systemd-run': {
    valued: [
      '-u',
      '--unit',
      '-p',
      '--property',
      '-E',
      '--setenv',
      '-M',
      '--machine',
      '--description',
      '--slice',
      '--uid',
      '--gid',
      '--working-directory',
    ],
  },
  busybox: { valued: [] },
  toybox: { valued: [] },
  coproc: { valued: [] },
  call: { valued: [] },
  noglob: { valued: [] },
  nocorrect: { valued: [] },
};

/** Слова оболочки перед командой, которые сами ничего не запускают. */
const RESERVED = new Set([
  '!',
  '{',
  '}',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  'time',
]);

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'mksh',
  'yash',
  'fish',
  'tcsh',
  'csh',
]);

/**
 * Печать и данные: аргументы этих команд не исполняются, поиск команды в словах не нужен.
 * Чего нет здесь и в обёртках, судится и по хвостам: `mywrap --x git push` → `git push`.
 */
const PRINT = new Set([
  'echo',
  'printf',
  'print',
  'grep',
  'egrep',
  'fgrep',
  'findstr',
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'dir',
  'test',
  '[',
  '[[',
  'cd',
  'pushd',
  'popd',
  'mkdir',
  'rmdir',
  'rm',
  'cp',
  'mv',
  'touch',
  'ln',
  'chmod',
  'chown',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'cmp',
  'stat',
  'du',
  'df',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'which',
  'whereis',
  'type',
  'file',
  'date',
  'sleep',
  'true',
  'false',
  ':',
  'export',
  'set',
  'unset',
  'local',
  'declare',
  'readonly',
  'typeset',
  'tee',
  'alias',
  'write-host',
  'write-output',
  'get-childitem',
  'get-content',
  'select-string',
  'set-content',
  'add-content',
  'out-file',
  'new-item',
  'remove-item',
  'copy-item',
  'move-item',
  'test-path',
  'set-location',
  'get-location',
  'set-alias',
  'new-alias',
  'sal',
  'git',
  'function',
]);

const CD = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);

type Aliases = ReadonlyMap<string, string>;

function parse(text: string, dialect: Dialect): ParsedScript {
  if (dialect === 'cmd') return parseCmd(text);
  if (dialect === 'ps') return parsePowerShell(text);
  return parseBash(text, dialect);
}

/** Строка оболочки после `-c` или имя файла; без того и другого — скрипт со stdin. */
function shellCall(args: readonly string[]): { script?: string; file?: string; stdin: boolean } {
  let hasC = false;
  let readsStdin = false;
  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i] as string;
    if (word === '--' || word === '-') {
      i++;
      break;
    }
    if (!/^[-+]/.test(word)) break;
    if (word.startsWith('--')) {
      if (word === '--rcfile' || word === '--init-file') i++;
      continue;
    }
    const letters = word.slice(1);
    if (letters.includes('c')) hasC = true;
    if (letters.includes('s')) readsStdin = true;
    if (/[oO]/.test(letters)) i++;
  }
  if (hasC) return { script: args[i] ?? '', stdin: false };
  if (readsStdin || i >= args.length) return { stdin: true };
  return { file: args[i] as string, stdin: false };
}

class Walk implements Visitor {
  private capped = false;
  readonly acc: ExecAnalysis;
  private readonly opts: AnalyzeOptions;
  /** Поиск команды в хвостах слов — только в чтении той оболочки, что исполнит строку. */
  private readonly scan: boolean;

  constructor(acc: ExecAnalysis, opts: AnalyzeOptions, scan: boolean) {
    this.acc = acc;
    this.opts = opts;
    this.scan = scan;
  }

  private over(depth: number): boolean {
    if (depth > MAX_DEPTH) {
      this.acc.unknown.push(`nesting deeper than ${MAX_DEPTH}`);
      return true;
    }
    if (this.acc.forms.length > MAX_FORMS) {
      if (!this.capped) this.acc.unknown.push(`more than ${MAX_FORMS} command forms`);
      this.capped = true;
      return true;
    }
    return false;
  }

  stdin(
    stdin: Stdin | undefined,
    dialect: Dialect,
    env: Env,
    aliases: Aliases,
    depth: number,
    who: string,
  ): void {
    if (stdin?.kind === 'text') this.script(stdin.text, dialect, env, aliases, depth + 1);
    else if (stdin?.kind === 'pipe') this.acc.unknown.push(`${who} runs a script from a pipe`);
  }

  script(text: string, dialect: Dialect, env: Env, aliases: Aliases, depth: number): void {
    if (this.over(depth)) return;
    // Строка bash с `\` читается и вторым чтением: путь Windows (`C:\Git\git.exe`) — не escape.
    if (dialect === 'bash' && text.includes('\\'))
      this.script(text, 'lenient', env, aliases, depth);
    const parsed = parse(text, dialect);
    this.acc.unknown.push(...parsed.unknown);
    for (const s of parsed.substitutions) this.script(s, dialect, env, aliases, depth + 1);
    // Окружение и псевдонимы строки переходят к следующим её командам.
    const scriptEnv = new Map(env);
    const shellAliases = new Map<string, string>();
    for (const command of parsed.commands) {
      let words = command.words.flatMap((w) => expandWord(w, scriptEnv, this.opts.home));
      const redirects = command.redirects.flatMap((w) => expandWord(w, scriptEnv, this.opts.home));
      this.record(words, redirects);
      if (words[0] === 'function') words = words.slice(2);
      const first = commandName(words[0] ?? '');
      if (
        first === 'export' ||
        first === 'declare' ||
        first === 'local' ||
        first === 'readonly' ||
        words.every((w) => ASSIGNMENT.test(w))
      ) {
        for (const w of words) {
          const m = ASSIGNMENT.exec(w);
          if (m) scriptEnv.set(m[1] as string, m[2] as string);
        }
        if (words.every((w) => ASSIGNMENT.test(w))) continue;
      }
      if (dialect === 'cmd' && first === 'set') {
        const m = ASSIGNMENT.exec(words.slice(1).join(' '));
        if (m) scriptEnv.set((m[1] as string).toUpperCase(), m[2] as string);
        continue;
      }
      if (first === 'alias') {
        for (const w of words.slice(1)) {
          const m = /^([^=]+)=(.*)$/s.exec(w);
          if (m) shellAliases.set(m[1] as string, m[2] as string);
        }
        continue;
      }
      if (['set-alias', 'new-alias', 'sal', 'nal'].includes(first)) {
        const [name, value] = words.slice(1).filter((w) => !w.startsWith('-'));
        if (name && value) shellAliases.set(name.toLowerCase(), value);
        continue;
      }
      if (CD.has(first)) this.cd(words.slice(1));
      const alias = shellAliases.get(dialect === 'ps' ? first : (words[0] ?? ''));
      if (alias !== undefined) {
        const rest = words.slice(1).map((w) => `'${w.replace(/'/g, `'\\''`)}'`);
        this.script(
          [alias, ...rest].join(' '),
          dialect === 'ps' ? 'ps' : 'bash',
          scriptEnv,
          aliases,
          depth + 1,
        );
        continue;
      }
      this.argv(words, scriptEnv, aliases, depth, command.stdin);
    }
  }

  private record(words: readonly string[], redirects: readonly string[]): void {
    let i = 0;
    while (i < words.length && ASSIGNMENT.test(words[i] as string)) i++;
    const head = commandName(words[i] ?? '');
    words.forEach((text, k) =>
      this.acc.words.push({ text, head, prev: words[k - 1] ?? '', redirect: false }),
    );
    for (const text of redirects) this.acc.words.push({ text, head, prev: '', redirect: true });
  }

  /** Цель `cd`: видимая — в `cwds`, с дырой или `cd -` — каталог не виден. */
  private cd(args: readonly string[]): void {
    const target = args.find((w) => !/^-[LPe@]$/.test(w) && !/^-path$/i.test(w));
    if (target === undefined) {
      if (this.opts.home) this.acc.cwds.push(this.opts.home);
      return;
    }
    if (target === '-' || isOpaque(target)) this.acc.cwdUnknown = true;
    else this.acc.cwds.push(target);
  }

  argv(
    argv: readonly string[],
    inherited: Env,
    aliases: Aliases,
    depth: number,
    stdin?: Stdin,
  ): void {
    if (this.over(depth)) return;
    const unwrapped = this.unwrap(argv, inherited, aliases, depth);
    if (!unwrapped) return;
    const { env } = unwrapped;
    const [head, ...args] = unwrapped.argv as [string, ...string[]];
    const name = commandName(head);
    if (name === 'git') return visitGit(args, env, aliases, depth, this);
    const dashed = /^git-(.+)$/.exec(name);
    if (dashed) return visitGit([dashed[1] as string, ...args], env, aliases, depth, this);
    this.acc.forms.push([isOpaque(head) ? head : name, ...args]);
    if (SHELLS.has(name)) return this.shell(name, args, env, aliases, depth, stdin);
    if (name === 'eval') return this.script(args.join(' '), 'bash', env, aliases, depth + 1);
    if (name === 'source' || name === '.') {
      if (args[0] !== undefined && (isProcessSubstitution(args[0]) || args[0] === '/dev/stdin')) {
        this.stdin({ kind: 'pipe' }, 'bash', env, aliases, depth, name);
      }
      return;
    }
    const runner = RUNNERS[name];
    if (runner) runner(args, env, aliases, depth, stdin, this);
    if (this.scan && !PRINT.has(name)) this.tails(args, env, aliases, depth);
  }

  private shell(
    name: string,
    args: string[],
    env: Env,
    aliases: Aliases,
    depth: number,
    stdin?: Stdin,
  ): void {
    const call = shellCall(args);
    const dialect: Dialect = 'bash';
    if (call.script !== undefined)
      return this.script(call.script, dialect, env, aliases, depth + 1);
    if (call.stdin) return this.stdin(stdin, dialect, env, aliases, depth, name);
    // Процесс-подстановка или `/dev/stdin` вместо файла — скрипт, которого не видно.
    if (
      call.file !== undefined &&
      (isProcessSubstitution(call.file) || call.file === '/dev/stdin')
    ) {
      this.stdin(
        call.file === '/dev/stdin' ? stdin : { kind: 'pipe' },
        dialect,
        env,
        aliases,
        depth,
        name,
      );
    }
  }

  /** Хвосты аргументов неизвестной команды, которые начинаются с команды: та может их исполнить. */
  private tails(args: readonly string[], env: Env, aliases: Aliases, depth: number): void {
    const heads = this.opts.heads ?? [];
    for (let j = 0; j < args.length; j++) {
      const n = commandName(args[j] as string);
      const runs =
        n === 'git' ||
        n.startsWith('git-') ||
        heads.includes(n) ||
        SHELLS.has(n) ||
        WRAPPERS[n] !== undefined ||
        (RUNNERS[n] !== undefined && !['find', 'rg', 'start'].includes(n)) ||
        n === 'eval';
      if (runs) this.argv(args.slice(j), env, aliases, depth);
    }
  }

  /** Снимает присваивания (в окружение), зарезервированные слова и обёртки. */
  private unwrap(
    argv: readonly string[],
    inherited: Env,
    aliases: Aliases,
    depth: number,
  ): { argv: string[]; env: Env } | null {
    const env = new Map(inherited);
    let rest = [...argv];
    for (let guard = 0; guard < 64; guard++) {
      for (let m = ASSIGNMENT.exec(rest[0] ?? ''); m; m = ASSIGNMENT.exec(rest[0] ?? '')) {
        env.set(m[1] as string, m[2] as string);
        rest = rest.slice(1);
      }
      if (!rest.length) return null;
      // Слово из одних дыр на месте команды может оказаться пустым: команда — следующее слово.
      if (onlyHoles(rest[0] as string) && rest.length > 1)
        this.argv(rest.slice(1), env, aliases, depth);
      const name = commandName(rest[0] as string);
      if (RESERVED.has(name)) {
        rest = rest.slice(1);
        continue;
      }
      const wrapper = WRAPPERS[name];
      if (!wrapper) return { argv: rest, env };
      // `command -v git push` только печатает путь — это не вызов git.
      if (name === 'command' && (rest[1] === '-v' || rest[1] === '-V')) return { argv: rest, env };
      let i = 1;
      while (i < rest.length) {
        const word = rest[i] as string;
        if (word === '--') {
          i++;
          break;
        }
        if (word === '-' && name === 'env') {
          i++;
          continue;
        }
        if (!word.startsWith('-') || word === '-') break;
        const [flag, inline] = word.startsWith('--') ? word.split(/=(.*)/s, 2) : [word, undefined];
        const takesValue = wrapper.valued.includes(flag as string);
        const value = takesValue && inline === undefined ? rest[i + 1] : inline;
        if (name === 'env' && (flag === '-S' || flag === '--split-string') && value !== undefined) {
          // `env -S "git push"` делит строку на слова сам.
          const after = rest.slice(i + (inline === undefined ? 2 : 1));
          const split = parseBash(value).chains[0] ?? [];
          rest = ['env', ...split, ...after];
          i = 1;
          continue;
        }
        i += takesValue && inline === undefined ? 2 : 1;
      }
      i += Math.min(wrapper.skip ?? 0, Math.max(0, rest.length - i - 1));
      rest = rest.slice(i);
    }
    this.acc.unknown.push('more than 64 wrappers');
    return null;
  }
}

/**
 * Разбор вызова: типизированный argv первой команды плюс вся строка оболочки (`display`
 * переходника). Строка читается так, как её прочтёт любая оболочка, которая могла её получить:
 * bash, bash с путями Windows (если в строке есть `\`), cmd и PowerShell — судья берёт объединение.
 */
export function analyzeExec(
  argv: readonly string[],
  script?: string,
  opts: AnalyzeOptions = {},
): ExecAnalysis {
  const acc: ExecAnalysis = {
    forms: argv.length ? [[...argv]] : [],
    hazards: [],
    unknown: [],
    words: [],
    cwds: [],
    cwdUnknown: false,
  };
  const primary = new Walk(acc, opts, true);
  if (argv.length) {
    argv.forEach((text, k) =>
      acc.words.push({
        text,
        head: commandName(argv[0] as string),
        prev: argv[k - 1] ?? '',
        redirect: false,
      }),
    );
    primary.argv(argv, new Map(), new Map(), 0);
  }
  if (!script) return acc;
  const ps = opts.primary === 'ps';
  const guess = new Walk(acc, opts, false);
  (ps ? guess : primary).script(script, 'bash', new Map(), new Map(), 0);
  guess.script(script, 'cmd', new Map(), new Map(), 0);
  (ps ? primary : guess).script(script, 'ps', new Map(), new Map(), 0);
  return acc;
}
