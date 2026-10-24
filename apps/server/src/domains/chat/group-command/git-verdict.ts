import {
  checkoutVerdict,
  cleanVerdict,
  noteResetDiscard,
  restoreVerdict,
  rmVerdict,
  switchVerdict,
  worktreeVerdict,
  type GitPlace,
} from './git-files.ts';
import {
  configVerdict,
  deletes,
  noteDestroys,
  noteDiscard,
  ownsBranch,
  runsProgram,
  safeConfigPair,
  disablesHooks,
  sharedRefsVerdict,
} from './git-guards.ts';
import {
  BRANCH_READ_FLAGS,
  foreignReads,
  GIT_READS,
  gitSegmentDestroys,
  READ_SIDE_EFFECT,
  remoteReads,
} from './git-reads.ts';
import { noteCloneTarget } from './git-clone.ts';
import { fetchVerdict, forgesTracking, pushVerdict } from './git-refspecs.ts';

export { foreignRepoReads, gitSegmentDestroys } from './git-reads.ts';
import { resolveFrom } from './paths.ts';
import type { Word } from './shell-parse.ts';
import {
  DANGER,
  OTHER,
  ROUTINE,
  isAbsolute,
  isProtectedBranch,
  type SegmentVerdict,
  type Walk,
} from './walk.ts';

/**
 * Звено `git …` (решения владельца 23.10 — паритет с авторежимом VS Code):
 * - карточка — удаление данных git (ветки, метки, тайника, ссылок, журнала
 *   ссылок, хранилища), слияние, кроме догона основной в свою ветку, пуш в
 *   основную или защищённую ветку и перезапись чужой, всё, что запускает
 *   названную командой программу (`rebase -x`, `-c core.editor=…`,
 *   `--upload-pack=…`), и ссылки, общие с другими копиями;
 * - само — прочая работа своей копии и своей ветки, включая перезапись своей
 *   ветки после rebase и затирание правок (после снимка, `git-files.ts`).
 */

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

/** Ключи `git merge`, берущие значение отдельным словом: `-m сообщение`, `-X theirs`. */
const MERGE_VALUED = /^(-m|-F|-X|-s|--strategy|--strategy-option|--file|--cleanup|--into-name)$/;

/**
 * Слияние, которое группе можно (политика 23.10): догон основной в свою рабочую
 * ветку — `git merge origin/main`, `origin/<ветка по умолчанию>`. Слияние любой
 * другой ветки (решение владельца 23.10: «мержить запрещено») — человеку.
 */
function mergesBase(args: Word[], base: string | undefined): boolean {
  const sources: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (arg.dynamic) return false;
    if (MERGE_VALUED.test(arg.text)) i += 1;
    else if (!arg.text.startsWith('-')) sources.push(arg.text);
  }
  const [source] = sources;
  if (sources.length !== 1 || !source) return false;
  return REBASE_BASES.has(source) || (Boolean(base) && source === `origin/${base}`);
}

const STASH_ROUTINE = new Set(['push', 'pop', 'apply', 'list', 'show', 'save']);

/**
 * `git branch -f/-m/-M/-C`: переставить, переименовать или затереть ветку —
 * ветки у копий общие. Переставить можно только свою (по git копии).
 * Переименовать (`-m`, без принуждения) — тоже только свою и не в основную или
 * защищённую (ревью 23.10: `git branch -m "<тикет>/<суть>"` в начале доставки —
 * ложные карточки); `-M` затирает чужую ветку с тем же именем — человеку.
 */
function branchVerdict(args: Word[], walk: Walk, cwd: string | undefined): SegmentVerdict {
  const texts = args.map((arg) => (arg.dynamic ? '\0' : arg.text));
  const short = (letters: RegExp) =>
    texts.some((text) => /^-[a-zA-Z]+$/.test(text) && letters.test(text));
  if (short(/[mMC]/) || texts.some((text) => /^--(move|copy)$/.test(text))) {
    const copy = short(/c/) || texts.includes('--copy');
    const forced = short(/[MCf]/) || texts.includes('--force');
    if (!copy && !forced) return renameVerdict(texts, walk, cwd);
    if (!copy || forced) return DANGER;
  }
  if (short(/f/) || texts.includes('--force')) {
    const [name] = texts.filter((text) => !text.startsWith('-'));
    return name && name !== '\0' && ownsBranch(walk, cwd, name) ? OTHER : DANGER;
  }
  if (walk.inCopy(cwd) && args.every((arg) => BRANCH_READ_FLAGS.has(arg.text))) return ROUTINE;
  return OTHER;
}

/**
 * `git branch -m [<старое>] <новое>`: старое — своя ветка (без него — текущая,
 * и она должна быть своей), новое — не основная и не защищённая. Переименовав
 * текущую, разбор следит за новым именем: `git push origin HEAD` следом судится
 * по нему.
 */
function renameVerdict(texts: string[], walk: Walk, cwd: string | undefined): SegmentVerdict {
  const names: string[] = [];
  for (const text of texts) {
    if (text === '\0') return DANGER;
    if (/^(-m|--move|-q|--quiet)$/.test(text)) continue;
    if (text.startsWith('-')) return DANGER;
    names.push(text);
  }
  if (names.length < 1 || names.length > 2) return DANGER;
  const current = walk.branchAt(cwd);
  const from = names.length === 2 ? names[0] : current;
  const to = names.at(-1) as string;
  if (!from || !ownsBranch(walk, cwd, from)) return DANGER;
  // Имя — без того, что git сам не примет (пробел, `~^:?*[\`, `..`, `@{`).
  const valid = /^[^-\s~^:?*[\\][^\s~^:?*[\\]*$/.test(to) && !/\.\.|@\{/.test(to);
  if (!valid || isProtectedBranch(to, walk.base)) return DANGER;
  if (from === current) walk.moveHead(to, cwd);
  return { kind: 'routine', writes: true };
}

const GLOBAL_FLAGS = new Set([
  '--no-pager',
  '-P',
  '-p',
  '--paginate',
  '--no-optional-locks',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-replace-objects',
  '--no-advice',
  '--no-lazy-fetch',
]);

/** Справка без подкоманды: `git --version`, `git --exec-path` (без `=`) — печать. */
const INFO_FLAGS = /^(--version|-v|--help|-h|--exec-path|--html-path|--man-path|--info-path)$/;

/**
 * Глобальные опции до подкоманды: `-C <каталог>` меняет каталог звена.
 * Прочие (`--git-dir`, `--work-tree`, `--exec-path=…`, `--config-env`, небезопасный
 * `-c`) решают, с каким репозиторием и какими программами пойдёт git, — человеку.
 */
function globalOptions(words: Word[], walk: Walk): GitPlace | typeof DANGER | typeof OTHER {
  let cwd = walk.cwd;
  let anchored = walk.anchored;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] as Word;
    const text = word.text;
    if (word.dynamic) return DANGER;
    if (text === '-C') {
      const dir = words[i + 1];
      if (dir && !dir.dynamic && isAbsolute(dir.text)) {
        cwd = resolveFrom('/', dir.text);
        anchored = true;
      } else {
        cwd = !dir || dir.dynamic || !cwd ? undefined : resolveFrom(cwd, dir.text);
      }
      i += 1;
      continue;
    }
    if (GLOBAL_FLAGS.has(text)) continue;
    if (text === '-c') {
      const value = words[i + 1];
      if (!value || value.dynamic) return DANGER;
      // Выключить хуки на одну команду — то же, что `--no-verify` (`disablesHooks`).
      if (!safeConfigPair(value.text) && !disablesHooks(value.text)) return DANGER;
      i += 1;
      continue;
    }
    if (INFO_FLAGS.test(text)) return OTHER;
    if (text.startsWith('-')) return DANGER;
    return { index: i, cwd, anchored };
  }
  return { index: words.length, cwd, anchored };
}

function noteDestroysLeniently(words: Word[]): void {
  if (gitSegmentDestroys(words)) noteDestroys();
}

/**
 * Затирание, что спускается в подмодули: правки в них сотрутся, а снимок копии
 * (`git-snapshot.ts`) держит только ссылку подмодуля (ревью 23.10, A-14).
 */
const SUBMODULE_DISCARDS = new Set(['reset', 'checkout', 'restore', 'switch', 'read-tree']);
/** `--recurse-submodules` и его сокращения (`--rec…`), которые git принимает. */
function recurses(text: string): boolean {
  const flag = text.split('=')[0] as string;
  return flag.length >= 5 && '--recurse-submodules'.startsWith(flag);
}

/** `-c core.excludesFile=…` у `clean`: игнорируемое станет «новым» и сотрётся без снимка (A-12). */
const EXCLUDES = /^core\.excludesfile=/i;

/**
 * Подкоманды, которые в пробном репозитории (свежий `mktemp -d` этой команды)
 * пишут только в него: пуск, история, ветки, индекс. Пуш, клон, удалённые,
 * подмодули и копии в этот список не входят — они ходят наружу.
 */
const SCRATCH_GIT = new Set([
  ...GIT_READS,
  'init',
  'add',
  'commit',
  'branch',
  'checkout',
  'switch',
  'merge',
  'rebase',
  'reset',
  'tag',
  'stash',
  'mv',
  'rm',
  'restore',
  'cherry-pick',
  'revert',
  'apply',
  'notes',
  'clean',
  'hash-object',
  'update-index',
  'update-ref',
  'symbolic-ref',
  'read-tree',
  'write-tree',
  'commit-tree',
]);

/**
 * Довод уводит git из пробного репозитория: абсолютный путь или подъём `..`
 * (`init /srv/x`, `--output=../f`), неизвестное значение, чужие настройки
 * (`config --global`), шаблон и каталог git в другом месте.
 */
function leavesScratch(arg: Word): boolean {
  const value = arg.text.includes('=') ? arg.text.slice(arg.text.indexOf('=') + 1) : arg.text;
  return (
    arg.dynamic === true ||
    isAbsolute(arg.text) ||
    isAbsolute(value) ||
    /(^|[\\/=])\.\.([\\/]|$)/.test(arg.text) ||
    READ_SIDE_EFFECT.test(arg.text) ||
    /^--(global|system|file|template|separate-git-dir|git-dir|work-tree)\b/.test(arg.text)
  );
}

/** Звено в пробном репозитории: настройки — те же ключи, что в копии (`configVerdict`). */
function scratchVerdict(sub: string, args: Word[]): SegmentVerdict | undefined {
  if (args.some(leavesScratch)) return undefined;
  if (sub === 'config') return configVerdict(args).kind === 'danger' ? DANGER : ROUTINE;
  return SCRATCH_GIT.has(sub) ? ROUTINE : undefined;
}

export function gitVerdict(words: Word[], walk: Walk): SegmentVerdict {
  noteDestroysLeniently(words);
  const global = globalOptions(words, walk);
  if (!('index' in global)) return global;
  const { index, cwd } = global;
  const sub = words[index]?.text;
  if (sub === undefined) return OTHER;
  const args = words.slice(index + 1);
  // Программа, которую назвала команда, — человеку где угодно, пробный репозиторий тоже.
  if (runsProgram(sub, args)) return DANGER;
  if (sub === 'clone') noteCloneTarget(args, walk, cwd);
  const inCopy = walk.inCopy(cwd);
  if (!inCopy && walk.inScratch(cwd)) {
    const scratch = scratchVerdict(sub, args);
    if (scratch) return scratch;
  }
  if (sub === 'config') {
    const verdict = configVerdict(args);
    if (verdict.kind === 'danger' || inCopy) return verdict;
    // Чтение чужих настроек — правилами чата; запись в них — человеку (A-03).
    return verdict.kind === 'routine' ? OTHER : DANGER;
  }
  const shared = sharedRefsVerdict(sub, args, walk, cwd);
  if (shared?.kind === 'danger') return DANGER;
  // Запись в репозиторий вне своей копии (`git -C /c/other commit`) — человеку (A-03).
  if (!inCopy && !foreignReads(sub, args)) return DANGER;
  if (SUBMODULE_DISCARDS.has(sub) && args.some((arg) => recurses(arg.text))) return DANGER;
  if (sub === 'clean' && words.slice(1, index).some((word) => EXCLUDES.test(word.text))) {
    return DANGER;
  }

  switch (sub) {
    // `send-pack` — та же отправка без настроек `push` (BGCD-rest, раунд 7).
    case 'send-pack':
    case 'push':
      return inCopy ? pushVerdict(args, walk, cwd) : DANGER;
    case 'merge': {
      if (!inCopy) return DANGER;
      if (args.some((arg) => /^--(abort|quit|continue)$/.test(arg.text))) return ROUTINE;
      // Догон основной в свою рабочую ветку — обычная работа (сито «интеграция»
      // само велит убрать конфликт); прочее слияние и слияние В основную или
      // защищённую — человеку.
      // Слияние в отсоединённую голову (`checkout --detach && merge origin/main`)
      // не двигает ни одной ветки — пробный догон; не вышло отсоединение — судим
      // по ветке, что была до него.
      const into = walk.branchAt(cwd) ?? walk.detachedFromAt(cwd);
      return into && !isProtectedBranch(into, walk.base) && mergesBase(args, walk.base)
        ? { kind: 'routine', writes: true }
        : DANGER;
    }
    case 'branch':
      // Удаление ветки — человеку при любой ветке (решение владельца 23.10).
      return deletes(args, /[dD]/) ? DANGER : branchVerdict(args, walk, cwd);
    case 'tag':
      if (deletes(args, /d/) || args.some((arg) => /^(-f|--force)$/.test(arg.text))) {
        return DANGER;
      }
      if (inCopy && (args.length === 0 || args.some((arg) => /^(-l|--list)$/.test(arg.text)))) {
        return ROUTINE;
      }
      return OTHER;
    case 'worktree':
      return worktreeVerdict(args, walk, global, inCopy);
    case 'stash': {
      const action = args[0]?.text;
      if (action === 'drop' || action === 'clear') return DANGER;
      if (!inCopy) return OTHER;
      return action === undefined || STASH_ROUTINE.has(action) ? ROUTINE : OTHER;
    }
    case 'checkout':
      return checkoutVerdict(args, walk, global);
    case 'switch':
      return switchVerdict(args, walk, global);
    case 'restore':
      return restoreVerdict(args, walk, global);
    case 'rm':
      return rmVerdict(args, walk, global);
    case 'clean':
      return cleanVerdict(args, inCopy);
    case 'reset':
      noteResetDiscard(args, walk, global);
      break;
    case 'checkout-index':
    case 'read-tree':
      if (inCopy && args.some((arg) => /^(-f|--force|-u|--reset)$/.test(arg.text))) {
        noteDiscard('discard');
      }
      break;
    default:
      break;
  }
  // Адрес `origin` — то, куда уходят пуши и откуда панель читает правду о
  // конфликте MR (`remoteConflicts`, F-31): переписать его — человеку.
  if (
    sub === 'remote' &&
    (args[0]?.dynamic === true || /^(add|set-url|rename|remove|rm)$/.test(args[0]?.text ?? ''))
  ) {
    return DANGER;
  }
  // Вне копии сюда доходит только чтение (`foreignReads`).
  if (!inCopy) return OTHER;
  if (shared) return shared;
  if (GIT_READS.has(sub)) {
    return args.some((arg) => READ_SIDE_EFFECT.test(arg.text)) ? OTHER : ROUTINE;
  }
  if (sub === 'remote') return remoteReads(args) ? ROUTINE : OTHER;
  if (sub === 'fetch') return fetchVerdict(args, walk, cwd);
  if (sub === 'pull' && forgesTracking(args, walk, cwd)) return DANGER;
  if (sub === 'add') return ROUTINE;
  if (sub === 'commit') return { kind: 'routine', writes: true };
  if (sub === 'rebase') return rebaseVerdict(args);
  return OTHER;
}
