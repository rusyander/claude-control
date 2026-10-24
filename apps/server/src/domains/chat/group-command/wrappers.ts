import { envUnwrap } from './env.ts';
import { findPlan } from './find.ts';
import { interpreterCode } from './interpreters.ts';
import { powershellUnwrap } from './powershell.ts';
import type { Word } from './shell-parse.ts';
import type { ScriptScope, Unwrapped } from './wrappers.types.ts';

export { isInterpreter } from './interpreters.ts';
export type { ScriptScope, Unwrapped } from './wrappers.types.ts';

/**
 * Обёртки, внутри которых исполняется другая команда. Раньше любая из них
 * (`timeout 60 pnpm test`, `bash -c '…'`, `find … -name '*.log' -delete`)
 * уводила звено в «прочее», а удаление в ней — к человеку, сколько бы ни было в
 * ней безопасного. Здесь обёртка снимается, и судится то, что она исполнит.
 */

/** Пропустить флаги обёртки: `values` — флаги со значением отдельным словом. */
function skipFlags(args: Word[], values: RegExp, flags: RegExp): Word[] | undefined {
  let i = 0;
  while (i < args.length) {
    const text = (args[i] as Word).text;
    if (text === '--') return args.slice(i + 1);
    if (values.test(text)) i += 2;
    else if (flags.test(text)) i += 1;
    else break;
  }
  return i <= args.length ? args.slice(i) : undefined;
}

const asCommand = (words: Word[] | undefined): Unwrapped | undefined =>
  words === undefined
    ? undefined
    : words.length === 0
      ? { kind: 'reader' }
      : { kind: 'command', words };

/** Сценарий словом: прочесть — судить его, нет — человеку. */
const script = (word: Word | undefined, scope: ScriptScope): Unwrapped =>
  word && !word.dynamic ? { kind: 'script', script: word.text, scope } : { kind: 'danger' };

function timeoutUnwrap(args: Word[]): Unwrapped | undefined {
  const rest = skipFlags(
    args,
    /^(-s|-k|--signal|--kill-after)$/,
    /^(-v|--verbose|--foreground|--preserve-status|--(signal|kill-after)=\S+)$/,
  );
  return rest && rest.length > 1 ? { kind: 'command', words: rest.slice(1) } : undefined;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

/** `bash -c '…'`, `sh -ec '…'`, `bash -lc '…'`: сценарий — слово за флагом с `c`. */
function shellScript(args: Word[]): Unwrapped | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (/^-[a-z]*c[a-z]*$/.test(text)) return script(args[i + 1], 'child');
    if (text === '-o' || text === '+o') i += 1;
    else if (!/^(-[euxvl]+|--(login|noprofile|norc|posix))$/.test(text)) return undefined;
  }
  return undefined;
}

/**
 * `trap [--] обработчик сигнал…`: обработчик исполнится при выходе. `-p`, `-l`,
 * сброс (`-`, одно слово-сигнал) — печать и сброс, ничего не исполняют.
 */
function trapUnwrap(args: Word[]): Unwrapped {
  const rest = args[0]?.text === '--' ? args.slice(1) : args;
  const [handler] = rest;
  if (!handler || rest.length < 2 || handler.text === '-') return { kind: 'reader' };
  if (!handler.dynamic && /^-[pl]$/.test(handler.text)) return { kind: 'reader' };
  return script(handler, 'deferred');
}

/** `alias имя='тело'`: тело исполнится при вызове имени — когда и где, не проследить. */
function aliasUnwrap(args: Word[]): Unwrapped {
  const bodies: string[] = [];
  for (const arg of args) {
    const at = arg.text.indexOf('=');
    if (at < 0) continue;
    if (arg.dynamic) return { kind: 'danger' };
    bodies.push(arg.text.slice(at + 1));
  }
  return bodies.length > 0
    ? { kind: 'script', script: bodies.join('\n'), scope: 'blind' }
    : { kind: 'reader' };
}

/** `flock [ключи] файл команда…` или `flock файл -c '…'`. */
function flockUnwrap(args: Word[]): Unwrapped | undefined {
  const rest = skipFlags(
    args,
    /^(-w|-E|--timeout|--conflict-exit-code)$/,
    /^(-[sxunoFe]+|--(shared|exclusive|unlock|nonblock|close|no-fork|verbose)|--[\w-]+=\S+)$/,
  );
  // Ключ, которого разбор не знает (`-xc '…'`): файл и команду уже не найти.
  if (!rest || rest.length < 2 || rest[0]?.text.startsWith('-')) return undefined;
  const command = rest.slice(1);
  if (/^(-c|--command)$/.test(command[0]?.text ?? '')) return script(command[1], 'child');
  return asCommand(command);
}

/** `taskset маска команда`, `taskset -c 0,1 команда`; `-p` — номер процесса, не команда. */
function tasksetUnwrap(args: Word[]): Unwrapped | undefined {
  if (args.some((arg) => /^-[a-z]*p/.test(arg.text))) return undefined;
  const listed = args.some((arg) => /^(-c|--cpu-list)$/.test(arg.text));
  const rest = skipFlags(args, /^(-c|--cpu-list)$/, /^(-a|--all-tasks)$/);
  return asCommand(listed ? rest : rest?.slice(1));
}

/** Метасимволы `cmd`: с ними строку уже не разобрать по пробелам. */
const CMD_META = /[&|<>^%!()"]/;
/**
 * Встроенные команды `cmd`, у которых `,`, `;` и `=` — тоже разделители:
 * `del /q a,C:\Users\me\file.txt` удаляет оба файла (F-12). У `echo` и `set`
 * это буквы.
 */
const CMD_SPLITTERS = new Set([
  'del',
  'erase',
  'rd',
  'rmdir',
  'md',
  'mkdir',
  'dir',
  'copy',
  'move',
  'ren',
  'rename',
  'type',
  'cd',
  'chdir',
  'pushd',
]);

/** `cmd /c dir C:\x`, `cmd.exe /d /s /c del /q x` — команда `cmd` простыми словами. */
function cmdUnwrap(args: Word[]): Unwrapped | undefined {
  const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg.text));
  if (
    at < 0 ||
    !args.slice(0, at).every((arg) => /^\/[dsqua]$|^\/[ev]:(on|off)$/i.test(arg.text))
  ) {
    return undefined;
  }
  const rest = args.slice(at + 1);
  if (rest.some((arg) => arg.dynamic)) return undefined;
  const line = rest.map((arg) => arg.text).join(' ');
  if (CMD_META.test(line)) return undefined;
  const [name = '', ...tail] = line.split(/\s+/).filter(Boolean);
  const splits = CMD_SPLITTERS.has(name.toLowerCase().replace(/\.exe$/, ''));
  const texts = [name, ...tail.flatMap((text) => (splits ? text.split(/[,;=]+/) : [text]))];
  const words = texts.filter(Boolean).map((text): Word => ({ text, dynamic: false }));
  return words.length > 0 ? { kind: 'command', words } : undefined;
}

/**
 * Обёртка снята: что звено исполнит. `undefined` — не обёртка или снять нельзя
 * (тогда звено судится, как раньше, целиком). `name` — имя команды уже без
 * пути, `.exe` и регистра.
 */
export function unwrap(name: string, words: Word[]): Unwrapped | undefined {
  const args = words.slice(1);
  switch (name) {
    case 'timeout':
      return timeoutUnwrap(args);
    case 'nice':
      return asCommand(skipFlags(args, /^-n$/, /^(-\d+|--adjustment=\S+|-n\d+)$/));
    case 'nohup':
    case 'builtin':
    case 'unbuffer':
      return asCommand(skipFlags(args, /^$/, /^-p$/));
    case 'exec':
      return asCommand(skipFlags(args, /^-a$/, /^-[cl]+$/));
    case 'setsid':
      return asCommand(skipFlags(args, /^$/, /^(-[cfw]+|--(ctty|fork|wait))$/));
    case 'coproc':
      // `coproc команда` — та же команда в фоне; `coproc ИМЯ { …; }` разбор не берёт.
      return asCommand(args);
    case 'busybox':
    case 'toybox':
      return args[0] && !args[0].text.startsWith('-') ? asCommand(args) : { kind: 'reader' };
    case 'doas':
      return asCommand(skipFlags(args, /^(-u|-C)$/, /^-[ns]+$/));
    case 'ionice':
      return asCommand(
        skipFlags(args, /^(-c|-n|--class|--classdata)$/, /^(-t|--ignore|-c\d|-n\d)$/),
      );
    case 'taskset':
      return tasksetUnwrap(args);
    case 'flock':
      return flockUnwrap(args);
    case 'stdbuf':
      return asCommand(skipFlags(args, /^-[ioe]$/, /^(-[ioe]\S+|--(input|output|error)=\S+)$/));
    case 'command':
      if (args[0] && /^-[vV]$/.test(args[0].text)) return { kind: 'reader' };
      return asCommand(skipFlags(args, /^$/, /^-p$/));
    case 'env':
      return envUnwrap(args);
    case 'eval':
      return args.every((arg) => !arg.dynamic)
        ? { kind: 'script', script: args.map((arg) => arg.text).join(' '), scope: 'same' }
        : { kind: 'danger' };
    case 'trap':
      return trapUnwrap(args);
    case 'alias':
      return aliasUnwrap(args);
    case 'cmd':
      return cmdUnwrap(args);
    case 'powershell':
    case 'pwsh':
      return powershellUnwrap(args);
    case 'find': {
      const plan = findPlan(args);
      return plan ? { kind: 'find', find: plan } : undefined;
    }
    default:
      break;
  }
  if (SHELLS.has(name)) return shellScript(args);
  const code = interpreterCode(name, args);
  return code ? { kind: 'code', code } : undefined;
}

/**
 * Слово со входа `xargs`: неизвестно, и раскрыть его нечем. `literalDollar` —
 * чтобы `walk.expand` не принял пустой текст за известное пустое слово: так
 * `printf 'reset --hard' | xargs git` судился как `git` без подкоманды и
 * проходил сам (ревью 23.10, R-02).
 */
const stdinWord = (text = ''): Word => ({ text, dynamic: true, literalDollar: true });

/** Строка замены `-I X`, `-IX`, `-i`, `--replace[=X]`: со входа придёт вместо неё. */
function replaceString(flags: Word[]): string | undefined {
  let found: string | undefined;
  flags.forEach((word, i) => {
    const text = word.text;
    if (text === '-I') found = flags[i + 1]?.text;
    else if (/^-I./.test(text)) found = text.slice(2);
    else if (/^-i/.test(text)) found = text.slice(2) || '{}';
    else if (/^--replace(=|$)/.test(text)) found = text.slice('--replace='.length) || '{}';
  });
  return found;
}

/**
 * `xargs [флаги] команда`: команда получит слова со входа — неизвестные. С
 * `-I {}` они встают вместо `{}` (и подкомандой git тоже: `xargs -I{} git {}`),
 * без него — дописываются в конец.
 */
export function xargsCommand(words: Word[]): Word[] | undefined {
  const args = words.slice(1);
  const rest = skipFlags(
    args,
    /^(-n|-P|-L|-I|-d|-a|-s|-E|--max-args|--max-procs|--delimiter|--arg-file)$/,
    /^(-0|-r|-t|-x|--null|--no-run-if-empty|--verbose|--exit|-[nPLsIi]\S*|--[\w-]+=\S+|--replace)$/,
  );
  if (!rest) return undefined;
  const command = rest.length > 0 ? rest : [{ text: 'echo', dynamic: false }];
  const replace = replaceString(args.slice(0, args.length - rest.length));
  if (!replace) return [...command, stdinWord()];
  const shell = SHELLS.has(command[0]?.text ?? '');
  return command.map((word, i) => {
    if (!word.text.includes(replace)) return word;
    // Сценарий `sh -c 'echo {}; cat {}'`: вход встаёт словом в сценарий — судим
    // его с неизвестной переменной на этом месте (`cat` — чтение, `rm`, `git` —
    // человеку). С `'` в сценарии вход мог бы закрыть кавычку — неизвестно всё.
    const script = shell && !word.dynamic && /^-[a-z]*c[a-z]*$/.test(command[i - 1]?.text ?? '');
    if (!script || word.text.includes("'")) return stdinWord(word.text);
    return { text: word.text.split(replace).join('"${__xargs_input}"'), dynamic: false };
  });
}
