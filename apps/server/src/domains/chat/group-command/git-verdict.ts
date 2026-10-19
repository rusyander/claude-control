import type { Word } from './shell-parse.ts';
import { resolveFrom } from './paths.ts';
import {
  DANGER,
  OTHER,
  ROUTINE,
  isProtectedBranch,
  type SegmentVerdict,
  type Walk,
} from './walk.ts';

/**
 * Звено `git …` по политике владельца 19.10: карточка — удаление (ветки, метки,
 * копии, тайника), любое слияние, пуш в основную или защищённую ветку,
 * принудительный пуш. Прочее своей копии — рутина или правила чата.
 */

/** Подкоманды git, которые только смотрят. */
const GIT_READS = new Set([
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
]);

const PUSH_QUIET_FLAGS = new Set([
  '-u',
  '--set-upstream',
  '--force-if-includes',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--progress',
  '--no-progress',
  '--porcelain',
]);

/** `refs/heads/x` → `x`; иные `refs/…` (метки, заметки) остаются как есть. */
function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * Пуш: в `origin`, без `--force`/`-f`/`+`/`:ветки`/`--delete`/`-o`, каждая
 * цель — не основная и не защищённая ветка. Аренда (`--force-with-lease`) —
 * только на свою ветку, которую копия держит по git, и только ею. Обычный пуш
 * своей или другой рабочей ветки — рутина: перемотка вперёд ничью работу не
 * стирает (политика владельца 19.10: «обычный пуш ветки MR — сам»).
 */
function pushVerdict(args: Word[], walk: Walk, cwd: string | undefined): SegmentVerdict {
  const current = walk.branchAt(cwd);
  const own = walk.ownBranchAt(cwd);
  const base = walk.base;
  let lease = false;
  const leaseRefs: string[] = [];
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.dynamic) return DANGER;
    const text = arg.text;
    if (text === '--force-with-lease') {
      lease = true;
      continue;
    }
    if (text.startsWith('--force-with-lease=')) {
      lease = true;
      leaseRefs.push(branchName(text.slice('--force-with-lease='.length).split(':')[0] ?? ''));
      continue;
    }
    if (PUSH_QUIET_FLAGS.has(text)) continue;
    if (text.startsWith('-')) return DANGER;
    positional.push(text);
  }
  const [remote, ...refspecs] = positional;
  if (remote !== undefined && remote !== 'origin') return DANGER;
  const targets: string[] = [];
  if (refspecs.length === 0) {
    if (!current) return DANGER;
    targets.push(current);
  }
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) return DANGER;
    const [source = '', target, extra] = refspec.split(':');
    // `:ветка` — удаление ветки на удалённом.
    if (extra !== undefined || source === '') return DANGER;
    const to = target === undefined ? (source === 'HEAD' ? current : source) : target;
    if (!to) return DANGER;
    targets.push(branchName(to));
  }
  for (const target of targets) {
    if (target.startsWith('refs/') || isProtectedBranch(target, base)) return DANGER;
  }
  if (lease) {
    if (!own) return DANGER;
    if (!targets.every((target) => target === own)) return DANGER;
    if (!leaseRefs.every((ref) => ref === own)) return DANGER;
  }
  return { kind: 'routine', writes: true, lease };
}

const REBASE_BASES = new Set(['origin/main', 'origin/master']);
const REBASE_FLAGS = new Set(['--continue', '--abort', '--skip', '--autostash', '--no-autostash']);

function rebaseVerdict(args: Word[]): SegmentVerdict {
  const texts = args.map((arg) => (arg.dynamic ? '' : arg.text));
  if (texts.length === 1 && REBASE_FLAGS.has(texts[0] as string))
    return { kind: 'routine', writes: true };
  const rest = texts.filter((text) => !REBASE_FLAGS.has(text));
  const onto = rest[0] === '--onto' ? rest.slice(1) : rest;
  if (onto.length >= 1 && onto.length <= (rest[0] === '--onto' ? 2 : 1)) {
    if (
      REBASE_BASES.has(onto[0] as string) &&
      !onto.slice(1).some((t) => t === '' || t.startsWith('-'))
    ) {
      return { kind: 'routine', writes: true };
    }
  }
  return OTHER;
}

const STASH_ROUTINE = new Set(['push', 'pop', 'apply', 'list', 'show', 'save']);

/** Короткий флаг с буквой удаления: `-d`, `-D`, `-df`, `-rd`. */
function deletes(args: Word[], letters: RegExp): boolean {
  return args.some(
    (arg) => arg.text === '--delete' || (/^-[a-zA-Z]+$/.test(arg.text) && letters.test(arg.text)),
  );
}

/** Читающие формы `git branch`: список, текущая ветка. */
const BRANCH_READ_FLAGS = new Set([
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

/** Глобальные опции до подкоманды: `-C <каталог>` меняет каталог звена. */
function globalOptions(
  words: Word[],
  walk: Walk,
): { index: number; cwd: string | undefined } | typeof DANGER | typeof OTHER {
  let cwd = walk.cwd;
  for (let i = 1; i < words.length; i += 1) {
    const text = (words[i] as Word).text;
    if (text === '-C') {
      const dir = words[i + 1];
      cwd = !dir || dir.dynamic || !cwd ? undefined : resolveFrom(cwd, dir.text);
      i += 1;
      continue;
    }
    if (text === '--no-pager') continue;
    if (text.startsWith('-')) {
      // `-c ключ=значение`, `--git-dir` и прочее: куда и как пойдёт git — уже не рутина.
      return words.slice(i).some((word) => /^(push|merge|branch|tag)$/.test(word.text))
        ? DANGER
        : OTHER;
    }
    return { index: i, cwd };
  }
  return { index: words.length, cwd };
}

export function gitVerdict(words: Word[], walk: Walk): SegmentVerdict {
  const global = globalOptions(words, walk);
  if (!('index' in global)) return global;
  const { index, cwd } = global;
  const sub = words[index]?.text;
  const args = words.slice(index + 1);
  const inCopy = walk.inCopy(cwd);

  // Удаление и слияние — человеку, в какой бы копии ни было.
  switch (sub) {
    case 'push':
      return inCopy ? pushVerdict(args, walk, cwd) : DANGER;
    case 'merge':
      // Начатое и одобренное слияние можно только прервать или довести.
      return args.some((arg) => /^--(abort|quit|continue)$/.test(arg.text)) ? OTHER : DANGER;
    case 'branch':
      if (deletes(args, /[dD]/)) return DANGER;
      if (inCopy && args.every((arg) => BRANCH_READ_FLAGS.has(arg.text))) return ROUTINE;
      return OTHER;
    case 'tag':
      return deletes(args, /d/) ? DANGER : OTHER;
    case 'worktree':
      return args[0]?.text === 'remove' ? DANGER : OTHER;
    case 'stash': {
      const action = args[0]?.text;
      if (action === 'drop' || action === 'clear') return DANGER;
      if (!inCopy) return OTHER;
      return action === undefined || STASH_ROUTINE.has(action) ? ROUTINE : OTHER;
    }
    case 'checkout':
    case 'switch':
      walk.checkout(args, cwd);
      return OTHER;
    case undefined:
      return OTHER;
    default:
      break;
  }
  if (!inCopy) return OTHER;
  if (GIT_READS.has(sub)) return ROUTINE;
  if (sub === 'add' || sub === 'fetch') return ROUTINE;
  if (sub === 'commit') return { kind: 'routine', writes: true };
  if (sub === 'rebase') return rebaseVerdict(args);
  return OTHER;
}
