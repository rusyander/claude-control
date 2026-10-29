import { GIT_PUSH_EQUIVALENT } from '../../../lib/publish-commands.ts';
import type { Env, Visitor } from './exec-argv.types.ts';
import { isOpaque } from './marks.ts';

/**
 * git изнутри (P28, core-s2 F-04): глобальные опции, псевдонимы, подкоманды, которые толкают
 * ветку (`send-pack`, `subtree push`, `http-push`…), и настройки, которые сами исполняют команду
 * (`core.sshCommand`, `core.pager`, `core.fsmonitor`, `credential.helper`…) — их значение
 * судится как строка оболочки. Настройки, чьё содержимое не видно или которые снимают закрытие
 * push ядра (`include.path`, `remote.*.pushurl`, `core.hooksPath`, `url.*.pushInsteadOf`…), —
 * опасность: при запрете публикации судья отказывает.
 */

/** Глобальные опции git, которым значение идёт отдельным словом. */
const GIT_OPTS_WITH_VALUE = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--attr-source',
  '--list-cmds',
]);

/**
 * Подкоманды, которые публикуют так же, как `push`, — общий список с оверлеем CLI (F-04):
 * `lib/publish-commands.ts`, сверка обоих замков — `lib/publish-commands.test.ts`.
 */
const PUSH_EQUIVALENT = GIT_PUSH_EQUIVALENT;

const ALIAS_KEY = /^alias\.([^=]+)$/i;

/** Ключи, содержимое которых не видно или которые снимают закрытие push ядра. */
const HAZARD_KEYS = [
  /^remote\..+\.pushurl$/i,
  /^core\.hookspath$/i,
  /^include\.path$/i,
  /^includeif\..+\.path$/i,
  /^url\..+\.pushinsteadof$/i,
  /^protocol\.(.+\.)?allow$/i,
  /^extensions\.worktreeconfig$/i,
  /^remote\.pushdefault$/i,
];

/** Ключи, значение которых git исполнит как команду. */
const COMMAND_KEYS = [
  /^core\.(sshcommand|pager|editor|fsmonitor|askpass|gitproxy|alternaterefscommand)$/i,
  /^sequence\.editor$/i,
  /^pager\..+$/i,
  /^diff\.external$/i,
  /^diff\..+\.(command|textconv)$/i,
  /^merge\..+\.driver$/i,
  /^filter\..+\.(clean|smudge|process)$/i,
  /^gpg\.(.+\.)?program$/i,
  /^credential\.(.+\.)?helper$/i,
  /^(difftool|mergetool)\..+\.cmd$/i,
  /^uploadpack\.packobjectshook$/i,
  /^interactive\.difffilter$/i,
  /^(browser|man)\..+\.cmd$/i,
  /^remote\..+\.(uploadpack|receivepack|vcs)$/i,
  /^sendemail\.(smtpserver|tocmd|cccmd|sendmailcmd)$/i,
];

/** Переменные окружения, которые git исполнит как команду. */
const COMMAND_ENV = new Set([
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PAGER',
  'PAGER',
  'EDITOR',
  'VISUAL',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXTERNAL_DIFF',
  'GIT_PROXY_COMMAND',
]);
/** Переменные, которые подсовывают git невидимый конфиг или чужие программы. */
const HAZARD_ENV = new Set([
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG',
  'GIT_EXEC_PATH',
]);

/** Опции подкоманд, значение которых git исполнит как команду. */
const COMMAND_OPTIONS = new Set([
  '-x',
  '--exec',
  '--extcmd',
  '--upload-pack',
  '--receive-pack',
  '--open-files-in-pager',
  '-O',
  '--httpd',
  '--tree-filter',
  '--index-filter',
  '--env-filter',
  '--parent-filter',
  '--msg-filter',
  '--commit-filter',
  '--tag-name-filter',
  '--setup',
]);
/** Подкоманды, у которых `-x`/`-O` значат команду (у других — что-то своё). */
const SHORT_COMMAND_OPTION: Record<string, string> = { rebase: '-x', difftool: '-x', grep: '-O' };

type Aliases = ReadonlyMap<string, string>;

/** Конфиг git из окружения: `GIT_CONFIG_KEY_n`/`VALUE_n` и `GIT_CONFIG_PARAMETERS`. */
function configFromEnv(env: Env, v: Visitor): string[] {
  const pairs: string[] = [];
  for (const [k, value] of env) {
    const m = /^GIT_CONFIG_KEY_(\d+)$/.exec(k);
    if (m) pairs.push(`${value}=${env.get(`GIT_CONFIG_VALUE_${m[1]}`) ?? ''}`);
    if (
      (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k) || k === 'GIT_CONFIG_PARAMETERS') &&
      isOpaque(value)
    ) {
      v.acc.hazards.push(`${k} from an unseen value`);
    }
  }
  const params = env.get('GIT_CONFIG_PARAMETERS');
  if (params) {
    for (const m of params.matchAll(/'([^']*)'(?:='([^']*)')?/g)) {
      pairs.push(m[2] === undefined ? (m[1] as string) : `${m[1]}=${m[2]}`);
    }
  }
  return pairs;
}

/** Ключ конфига со значением: опасность, команда или ничего. */
function judgeConfig(
  key: string,
  value: string,
  origin: string,
  env: Env,
  aliases: Aliases,
  depth: number,
  v: Visitor,
): void {
  if (HAZARD_KEYS.some((re) => re.test(key))) v.acc.hazards.push(`${origin} ${key}`);
  if (ALIAS_KEY.test(key) && isOpaque(value)) v.acc.hazards.push(`${origin} ${key} unseen value`);
  if (COMMAND_KEYS.some((re) => re.test(key))) {
    if (isOpaque(value)) v.acc.hazards.push(`${origin} ${key} runs an unseen command`);
    else v.script(value.replace(/^!/, ''), 'bash', env, aliases, depth + 1);
  }
}

interface GitParse {
  tail: string[];
  aliases: Map<string, string>;
}

function parseGit(
  args: readonly string[],
  env: Env,
  inherited: Aliases,
  depth: number,
  v: Visitor,
): GitParse {
  const aliases = new Map(inherited);
  const define = (pair: string, origin: string) => {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? 'true' : pair.slice(eq + 1);
    if (isOpaque(key)) v.acc.hazards.push(`${origin} with an unseen key`);
    const m = ALIAS_KEY.exec(key);
    // Имя ключа конфига git без учёта регистра.
    if (m && eq >= 0) aliases.set((m[1] as string).toLowerCase(), value);
    judgeConfig(key, value, origin, env, aliases, depth, v);
  };
  for (const pair of configFromEnv(env, v)) define(pair, 'env config');
  for (const [name, value] of env) {
    if (HAZARD_ENV.has(name)) v.acc.hazards.push(`${name} points git at unseen config`);
    if (COMMAND_ENV.has(name)) {
      if (isOpaque(value)) v.acc.hazards.push(`${name} runs an unseen command`);
      else v.script(value, 'bash', env, aliases, depth + 1);
    }
  }
  let i = 0;
  while (i < args.length) {
    const word = args[i] as string;
    if (word === '--') {
      i++;
      break;
    }
    if (!word.startsWith('-')) break;
    const [flag, inline] = word.startsWith('--') ? word.split(/=(.*)/s, 2) : [word, undefined];
    const takesValue = GIT_OPTS_WITH_VALUE.has(flag as string) && inline === undefined;
    const value = takesValue ? args[i + 1] : inline;
    if (flag === '-c' && value !== undefined) define(value, '-c');
    if (flag === '--config-env' && value !== undefined) {
      // Значение — из переменной окружения: заданная этой строкой судится, как `-c`; окружение
      // сессии модель этой строкой не пишет — невидимым остаётся только псевдоним и опасный ключ.
      const [key = '', name = ''] = value.split(/=(.*)/s, 2);
      const set = env.get(name);
      if (set !== undefined) define(`${key}=${set}`, '--config-env');
      else if (ALIAS_KEY.test(key) || HAZARD_KEYS.some((re) => re.test(key))) {
        v.acc.hazards.push(`--config-env ${key}`);
      }
    }
    if (flag === '--exec-path' && inline !== undefined) v.acc.hazards.push('--exec-path');
    i += takesValue ? 2 : 1;
  }
  return { tail: args.slice(i), aliases };
}

/** Опции `git config`, которым значение идёт отдельным словом. */
const CONFIG_OPTS_WITH_VALUE = new Set([
  '-f',
  '--file',
  '--blob',
  '--type',
  '--default',
  '--comment',
  '--value',
]);
const CONFIG_READ_MODES = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '--list',
  '-l',
  '-e',
  '--edit',
]);
const CONFIG_REMOVE_MODES = new Set([
  '--unset',
  '--unset-all',
  '--rename-section',
  '--remove-section',
]);
const CONFIG_READ_VERBS = new Set(['get', 'list', 'edit']);
const CONFIG_REMOVE_VERBS = new Set(['unset', 'rename-section', 'remove-section']);

type ConfigOp =
  { mode: 'set'; key: string; value: string } | { mode: 'remove'; key: string } | null;

/** Что делает `git config`: запись ключа, удаление ключа/раздела или чтение. */
function configOp(args: readonly string[]): ConfigOp {
  const positional: string[] = [];
  let remove = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (word.startsWith('-') && word !== '-') {
      const [flag, inline] = word.startsWith('--') ? word.split(/=(.*)/s, 2) : [word, undefined];
      if (CONFIG_READ_MODES.has(flag as string)) return null;
      if (CONFIG_REMOVE_MODES.has(flag as string)) remove = true;
      if (CONFIG_OPTS_WITH_VALUE.has(flag as string) && inline === undefined) i++;
      continue;
    }
    positional.push(word);
  }
  if (CONFIG_READ_VERBS.has(positional[0] ?? '')) return null;
  if (CONFIG_REMOVE_VERBS.has(positional[0] ?? '')) {
    remove = true;
    positional.shift();
  } else if (positional[0] === 'set') positional.shift();
  const [key, value] = positional;
  if (key === undefined) return null;
  if (remove) return { mode: 'remove', key };
  return value !== undefined ? { mode: 'set', key, value } : null;
}

/** Снятие ключа или раздела, на котором держится закрытие push ядра. */
function removesClosure(key: string): boolean {
  return HAZARD_KEYS.some((re) => re.test(key)) || /^(remote|core|extensions)(\.|$)/i.test(key);
}

export function visitGit(
  args: readonly string[],
  env: Env,
  inherited: Aliases,
  depth: number,
  v: Visitor,
): void {
  const git = parseGit(args, env, inherited, depth, v);
  v.acc.forms.push(['git', ...git.tail]);
  const [sub, ...rest] = git.tail;
  if (sub === undefined) return;
  const action = rest.find((w) => !w.startsWith('-'));
  for (const form of PUSH_EQUIVALENT) {
    if (form[0] === sub && (form[1] === undefined || form[1] === action)) {
      v.acc.forms.push(['git', 'push', ...rest]);
    }
  }
  if (sub === 'config') {
    const op = configOp(rest);
    if (op?.mode === 'remove' && removesClosure(op.key))
      v.acc.hazards.push(`git config removes ${op.key}`);
    if (op?.mode === 'set') {
      judgeConfig(op.key, op.value, 'git config', env, git.aliases, depth, v);
      const alias = ALIAS_KEY.exec(op.key);
      if (alias) {
        // Записанный псевдоним судится так, как он исполнится при вызове.
        const name = (alias[1] as string).toLowerCase();
        v.argv(['git', '-c', `alias.${name}=${op.value}`, name], env, git.aliases, depth + 1);
      }
    }
  }
  if (sub === 'remote') {
    const verb = rest.find((w) => !w.startsWith('-'));
    const pushFlag = rest.includes('--push');
    // Новый, удалённый или переименованный remote и `set-url --push` — мимо закрытия push.
    if (
      (verb === 'set-url' && pushFlag) ||
      ['add', 'remove', 'rm', 'rename'].includes(verb ?? '')
    ) {
      v.acc.hazards.push(`git remote ${verb}${pushFlag ? ' --push' : ''}`);
    }
  }
  const shortCommand = SHORT_COMMAND_OPTION[sub];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] as string;
    const [flag, inline] = word.startsWith('--') ? word.split(/=(.*)/s, 2) : [word, undefined];
    const isShort = flag === shortCommand || (flag === '-u' && sub === 'clone');
    if (!(COMMAND_OPTIONS.has(flag as string) && (flag?.startsWith('--') || isShort))) {
      if (sub === 'grep' && /^-O./.test(word))
        v.script(word.slice(2), 'bash', env, git.aliases, depth + 1);
      continue;
    }
    const value = inline ?? rest[++i];
    if (value === undefined) continue;
    if (isOpaque(value)) v.acc.hazards.push(`git ${sub} ${flag} runs an unseen command`);
    else v.script(value, 'bash', env, git.aliases, depth + 1);
  }
  if (sub === 'submodule') {
    const at = rest.indexOf('foreach');
    if (at >= 0) {
      // `foreach [--recursive] [-q] <команда>`: опции до команды пропускаются.
      let i = at + 1;
      while ((rest[i] ?? '').startsWith('-')) i++;
      v.script(rest.slice(i).join(' '), 'bash', env, git.aliases, depth + 1);
    }
  }
  if (sub === 'bisect' && rest[0] === 'run') v.argv(rest.slice(1), env, git.aliases, depth + 1);
  const expansion = git.aliases.get(sub.toLowerCase());
  if (expansion === undefined) return;
  if (expansion.startsWith('!')) {
    // Псевдоним оболочки: каждая команда строки судится как отдельный вызов.
    v.script(expansion.slice(1), 'bash', env, git.aliases, depth + 1);
    return;
  }
  v.script(`git ${expansion} ${rest.map(quote).join(' ')}`, 'bash', env, git.aliases, depth + 1);
}

/** Слово обратно в строку оболочки — дословно, в одинарных кавычках. */
function quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
