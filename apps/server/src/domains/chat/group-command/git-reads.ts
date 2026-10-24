import { destroysOrMerges } from './git-guards.ts';
import type { Word } from './shell-parse.ts';

/**
 * Подкоманды git, которые только смотрят. `merge-tree --write-tree` пишет
 * объекты, но не ветки: это сверка с основной перед пушем, а не слияние.
 * Вынесено из `git-verdict.ts` по размеру вместе с поиском подкоманды.
 */
export const GIT_READS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
  'describe',
  'blame',
  'shortlog',
  'merge-base',
  'merge-tree',
  'cat-file',
  'ls-tree',
  'for-each-ref',
  'show-ref',
  'rev-list',
  'name-rev',
  'version',
  'grep',
  'diff-tree',
  'diff-index',
  'diff-files',
  'ls-remote',
  'count-objects',
  'cherry',
  'range-diff',
  'whatchanged',
  'check-ignore',
  'check-attr',
  'var',
]);

/** Чтение, которое всё же пишет или исполняет: `diff --output=файл`, `grep -O<программа>`. */
export const READ_SIDE_EFFECT = /^(--output\b|-O|--open-files-in-pager\b)/;

/** `git remote`, `git remote -v`, `git remote get-url origin`, `git remote show origin`. */
export function remoteReads(args: Word[]): boolean {
  const first = args[0]?.text;
  if (first === undefined) return true;
  if (first === '-v' || first === '--verbose') return args.length === 1;
  return first === 'get-url' || first === 'show';
}

/** Читающие формы `git branch`: список, текущая ветка. */
export const BRANCH_READ_FLAGS = new Set([
  '--show-current',
  '--list',
  '-l',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '--contains',
  '--merged',
  '--no-merged',
]);

/** Глобальные опции, берущие значение отдельным словом, — для грубого поиска подкоманды. */
const VALUED_GLOBAL = /^(-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/;

/** Место подкоманды в звене `git …` — грубо, мимо строгого разбора опций; `-1` — нет её. */
function subcommandAt(words: Word[]): number {
  for (let i = 1; i < words.length; i += 1) {
    const text = (words[i] as Word).text;
    if (VALUED_GLOBAL.test(text)) i += 1;
    else if (!text.startsWith('-')) return i;
  }
  return -1;
}

/** Подкоманды, что вне своей копии заводят новое, а не пишут в чужое. */
const CREATES = new Set(['clone', 'init', 'help']);

/**
 * Звено git над репозиторием вне своей копии только смотрит (ревью 23.10, A-03:
 * `git -C /c/other commit`, `GIT_DIR=<чужой> git commit` шли сами). Запись туда —
 * человеку; чтение — как раньше, правилами чата.
 */
export function foreignReads(sub: string, args: Word[]): boolean {
  const first = args[0]?.text;
  if (GIT_READS.has(sub)) return !args.some((arg) => READ_SIDE_EFFECT.test(arg.text));
  if (CREATES.has(sub)) return true;
  switch (sub) {
    case 'remote':
      return remoteReads(args);
    case 'stash':
    case 'notes':
      return /^(list|show)$/.test(first ?? '');
    case 'worktree':
      return first === 'list';
    case 'reflog':
      return first === undefined || /^(show|exists|list)$/.test(first);
    case 'branch':
      return args.every((arg) => BRANCH_READ_FLAGS.has(arg.text));
    case 'tag':
      return args.length === 0 || args.some((arg) => /^(-l|--list)$/.test(arg.text));
    case 'config':
      return args.length === 1 || args.some((arg) => /^(--get\S*|-l|--list)$/.test(arg.text));
    default:
      return false;
  }
}

/** То же по словам звена целиком (`GIT_DIR=… git …`). */
export function foreignRepoReads(words: Word[]): boolean {
  const at = subcommandAt(words);
  if (at < 0) return true;
  const sub = words[at] as Word;
  return !sub.dynamic && foreignReads(sub.text, words.slice(at + 1));
}

/**
 * Псевдоним из `-c alias.<имя>=<развёртка>` (и склеенного `-calias.…`) для этой
 * подкоманды; `''` — значение не узнать (`--config-env`). `undefined` — нет его.
 */
function aliasOf(globals: Word[], sub: string): string | undefined {
  const key = `alias.${sub.toLowerCase()}=`;
  for (let i = 0; i < globals.length; i += 1) {
    const text = (globals[i] as Word).text;
    const value =
      text === '-c' ? globals[i + 1] : /^-c./.test(text) ? { text: text.slice(2) } : undefined;
    if (/^--config-env(=|$)/.test(text) && /alias\./i.test(text + (globals[i + 1]?.text ?? ''))) {
      return '';
    }
    if (!value) continue;
    if ((value as Word).dynamic) return '';
    if (value.text.toLowerCase().startsWith(key)) return value.text.slice(key.length);
  }
  return undefined;
}

/**
 * Удаление и слияние отмечаются до строгого разбора опций: одиночный чат
 * отдаёт их человеку, даже если строгий разбор споткнулся о `--git-dir`.
 * Подкоманда из ввода (`printf 'branch -D y' | xargs git`) — какая, не узнать;
 * псевдоним из `-c alias.x='branch -D'` судится развёрткой, `!программа` —
 * человеку (ревью 23.10, A-23).
 */
export function gitSegmentDestroys(words: Word[]): boolean {
  const at = subcommandAt(words);
  if (at < 0) return false;
  const sub = words[at] as Word;
  if (sub.dynamic) return true;
  const args = words.slice(at + 1);
  const alias = aliasOf(words.slice(1, at), sub.text);
  if (alias === undefined) return destroysOrMerges(sub.text, args);
  if (alias === '' || alias.trimStart().startsWith('!')) return true;
  const [name = '', ...rest] = alias.trim().split(/\s+/);
  const expanded = rest.map((text): Word => ({ text, dynamic: false }));
  return destroysOrMerges(name, [...expanded, ...args]);
}
