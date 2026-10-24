import { checkedOut } from './branch.ts';
import { longFlag, noteDiscard, ownsBranch } from './git-guards.ts';
import { segmentMatches } from './glob.ts';
import { canonical, resolveFrom } from './paths.ts';
import type { Word } from './shell-parse.ts';
import { pathsVerdict, targetKind } from './targets.ts';
import { DANGER, OTHER, ROUTINE, isAbsolute, type SegmentVerdict, type Walk } from './walk.ts';

/**
 * Звенья git над файлами копии: перезапись из git, удаление, смена ветки,
 * временные копии. Что из этого сотрёт незакоммиченное, отмечается для маршрута
 * прав (`noteDiscard`): затирание идёт само, но после снимка в
 * `refs/agentdeck/backup/…`, смена ветки на грязном дереве — отказ агенту.
 */

export interface GitPlace {
  index: number;
  cwd: string | undefined;
  anchored: boolean;
}

/**
 * `git checkout [<ревизия>] -- пути`: перезапись файлов копии из git. Без `--`
 * это смена ветки — её ведёт `Walk.checkout`.
 */
function checkoutPaths(args: Word[]): Word[] | undefined {
  const end = args.findIndex((arg) => arg.text === '--');
  if (end < 0) return undefined;
  const before = args
    .slice(0, end)
    .filter((arg) => !/^(-q|--quiet|-f|--force|--ours|--theirs)$/.test(arg.text));
  if (before.length > 1 || before.some((arg) => arg.text.startsWith('-'))) return undefined;
  const paths = args.slice(end + 1);
  return paths.length > 0 ? paths : undefined;
}

/**
 * `git restore`: только индекс (`--staged` без `--worktree`) — ничего не
 * теряется; файлы копии — по целям. `undefined` — форма незнакомая.
 */
function restorePaths(args: Word[]): { staged: true } | { paths: Word[] } | undefined {
  let staged = false;
  let worktree = false;
  const paths: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    const text = arg.text;
    if (text === '--') {
      paths.push(...args.slice(i + 1));
      break;
    }
    if (text === '-s' || text === '--source') i += 1;
    else if (/^(-S|--staged)$/.test(text)) staged = true;
    else if (/^(-W|--worktree)$/.test(text)) worktree = true;
    else if (/^(-SW|-WS)$/.test(text)) staged = worktree = true;
    else if (
      /^(-q|--quiet|--progress|--no-progress|--ours|--theirs|--ignore-unmerged|--source=\S+|-s\S+)$/.test(
        text,
      )
    ) {
      continue;
    } else if (text.startsWith('-')) return undefined;
    else paths.push(arg);
  }
  if (paths.length === 0) return undefined;
  return staged && !worktree ? { staged: true } : { paths };
}

/**
 * Путь git, задевающий `.git` копии — буквально или шаблоном так, как его раскроет
 * оболочка (`.g*`, `.gi?`, `.[g]it`: `glob.ts`), или неизвестный (подстановка).
 * Строка «история git» из коробки `auto` пропустила бы его молча (F-05).
 */
function touchesGitDir(word: Word, walk: Walk): boolean {
  const path = walk.expand(word);
  if (path.dynamic) return true;
  return path.text
    .replace(/\\/g, '/')
    .split('/')
    .some((part) => segmentMatches(part, '.git', walk.dotglob));
}

/** Файлы копии, которые перезапишет или удалит git: восстановимое — рутина, прочее — правилам чата. */
function overwriteVerdict(
  paths: Word[],
  walk: Walk,
  place: GitPlace,
  discards = true,
): SegmentVerdict {
  // Вне своей копии — человеку: строка «история git» у группы из коробки
  // `auto` и пропустила бы затирание чужой работы.
  if (!walk.inCopy(place.cwd)) return DANGER;
  if (paths.some((path) => touchesGitDir(path, walk))) return DANGER;
  if (discards) noteDiscard('discard');
  return pathsVerdict(paths, walk, place) ?? OTHER;
}

/**
 * Смена ветки без принуждения ничего не ломает, лишь несёт правки с собой —
 * владелец велел сперва их закоммитить (23.10): отмечаем, отказ на грязном
 * дереве дадут права. Принудительная (`-f`, `--discard-changes`) ещё и стирает.
 */
export function switchVerdict(args: Word[], walk: Walk, place: GitPlace): SegmentVerdict {
  const texts = args.map((arg) => (arg.dynamic ? '\0' : arg.text));
  const inCopy = walk.inCopy(place.cwd);
  // `-B`/`-C` переставит уже существующую ветку — ветки у копий общие.
  const reset = texts.findIndex((text) => /^-(B|C)$|^--force-create$/.test(text));
  if (reset >= 0) {
    const name = texts[reset + 1];
    if (!name || name === '\0' || !ownsBranch(walk, place.cwd, name)) return DANGER;
  }
  if (inCopy) {
    if (texts.some((text) => /^(-f|--force|--discard-changes)$/.test(text))) {
      noteDiscard('discard');
    }
    // Голый `git checkout` / `git switch` лишь печатает; прочее меняет ветку.
    if (texts.some((text) => !/^(-q|--quiet|--progress|--no-progress)$/.test(text))) {
      noteDiscard('switch');
    }
  }
  walk.moveHead(checkedOut(args), place.cwd);
  return OTHER;
}

export function checkoutVerdict(args: Word[], walk: Walk, place: GitPlace): SegmentVerdict {
  const paths = checkoutPaths(args);
  if (paths) return overwriteVerdict(paths, walk, place);
  // F-19: `checkout main --` без путей после `--` — смена ветки, а не откат
  // файлов. Раньше её судили как перезапись всего, ветка разбора оставалась
  // своей, и `git push origin HEAD` следом на чистом дереве уходил в main сам.
  const end = args.findIndex((arg) => arg.text === '--');
  if (end >= 0 && end === args.length - 1) return switchVerdict(args, walk, place);
  // `--` в форме, которую не разобрать: пути не проследить — как перезапись всего.
  if (end >= 0) {
    if (!walk.inCopy(place.cwd)) return DANGER;
    noteDiscard('discard');
    return OTHER;
  }
  return switchVerdict(args, walk, place);
}

export function restoreVerdict(args: Word[], walk: Walk, place: GitPlace): SegmentVerdict {
  const inCopy = walk.inCopy(place.cwd);
  const restore = restorePaths(args);
  if (!restore) {
    if (inCopy) noteDiscard('discard');
    return OTHER;
  }
  if ('staged' in restore) return inCopy ? ROUTINE : OTHER;
  return overwriteVerdict(restore.paths, walk, place);
}

/** `git reset --hard` / `--merge`: стирает правки в отслеживаемом. `--keep` git сам не даст. */
export function noteResetDiscard(args: Word[], walk: Walk, place: GitPlace): void {
  if (!walk.inCopy(place.cwd)) return;
  if (args.some((arg) => /^--(hard|merge)$/.test(arg.text))) noteDiscard('discard');
}

/**
 * `git worktree remove [--force] путь`: сносится сама рабочая папка с её
 * несохранённым. Внутри своей копии (`.agent/tmp/base-wt` — сверка с основной,
 * решение владельца 23.10) — уборка; соседняя копия, основная или папка вне
 * своей копии — человеку.
 *
 * RF-BGCD-03: `move`, `lock`, `unlock`, `repair` и `prune` трогают и чужие копии —
 * `worktree move <соседняя> .agent/tmp/x`, а следом `rm -rf .agent/tmp/x`, сносили
 * незакоммиченное соседней группы. Перенос — только копии внутри своей и только
 * внутрь своей или во временное; замок и починка — своей копии или копии внутри
 * неё; `prune` — когда всё, что он снесёт сейчас (`walk.prunable`, живой `git
 * worktree list`), лежит внутри своей копии.
 */
export function worktreeVerdict(
  args: Word[],
  walk: Walk,
  place: GitPlace,
  inCopy: boolean,
): SegmentVerdict {
  const action = args[0]?.text;
  if (action === 'remove') {
    const paths = args.slice(1).filter((arg) => !/^(-f|--force)$/.test(arg.text));
    const [path] = paths;
    if (paths.length !== 1 || !path || path.text.startsWith('-')) return DANGER;
    return insideOwnCopy(path, walk, place) ? { kind: 'routine', deletes: true } : DANGER;
  }
  if (action !== undefined && /^(move|lock|unlock|repair|prune)$/.test(action)) {
    return inCopy ? worktreeUpkeep(action, args.slice(1), walk, place) : DANGER;
  }
  if (!inCopy) return OTHER;
  if (action === 'add') {
    // Черновая копия для сверки — во временном: запись git, строка «запись в git».
    // `-B` переставит уже существующую ветку — ветки у копий общие (как `switch -C`).
    const reset = args.findIndex((arg) => arg.text === '-B');
    if (reset >= 0) {
      const name = args[reset + 1];
      if (!name || name.dynamic || !ownsBranch(walk, place.cwd, name.text)) return DANGER;
    }
    // Создание копии — запись, а не уборка: `/tmp/wt` для неё временное (F-77).
    // Внутри своей копии — само, в любом другом месте — человеку (решение владельца 23.10).
    const path = skipValuedGit(args.slice(1)).at(0);
    if (!path) return OTHER;
    return targetKind(path, walk, { ...place, write: true }) === 'temp' ||
      insideOwnCopy(path, walk, place)
      ? { kind: 'routine', writes: true }
      : DANGER;
  }
  return action === 'list' ? ROUTINE : OTHER;
}

/** `worktree move|lock|unlock|repair|prune` своей копии (`worktreeVerdict`). */
function worktreeUpkeep(action: string, args: Word[], walk: Walk, place: GitPlace): SegmentVerdict {
  const named: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (/^(--reason|--expire)$/.test(arg.text)) i += 1;
    else if (!arg.text.startsWith('-') || arg.dynamic) named.push(arg);
  }
  const ownOrInside = (word: Word): boolean =>
    insideOwnCopy(word, walk, place) || isOwnCopy(word, walk, place);
  switch (action) {
    case 'move': {
      const [from, to, extra] = named;
      if (!from || !to || extra || !insideOwnCopy(from, walk, place)) return DANGER;
      return insideOwnCopy(to, walk, place) ||
        targetKind(to, walk, { ...place, write: true }) === 'temp'
        ? { kind: 'routine', writes: true }
        : DANGER;
    }
    case 'lock':
    case 'unlock':
      return named.length === 1 && ownOrInside(named[0] as Word) ? OTHER : DANGER;
    case 'repair':
      return named.every(ownOrInside) ? OTHER : DANGER;
    default: {
      if (args.some((arg) => /^(-n|--dry-run)$/.test(arg.text))) return ROUTINE;
      const prunable = walk.prunable;
      if (!prunable) return DANGER;
      return prunable.every((path) => {
        const placed = walk.rootOf(canonical(path));
        return placed !== undefined && placed.path !== placed.root;
      })
        ? ROUTINE
        : DANGER;
    }
  }
}

/** Слово — сама своя копия (её корень), как его видит git звена. */
function isOwnCopy(word: Word, walk: Walk, place: GitPlace): boolean {
  const path = walk.expand(word);
  if (path.dynamic || !place.cwd) return false;
  return walk.isCopyRoot(resolveFrom(place.cwd, path.text));
}

/**
 * Путь внутри своей копии, но не она сама и не её `.git`. Относительный путь
 * при угаданном каталоге оболочки — только временный (`.agent/tmp/…`): оболочка
 * могла уйти из копии соседним вызовом.
 */
function insideOwnCopy(word: Word, walk: Walk, place: GitPlace): boolean {
  const path = walk.expand(word);
  if (path.dynamic || !place.cwd) return false;
  const placed = walk.rootOf(resolveFrom(place.cwd, path.text));
  if (!placed || placed.path === placed.root || /(^|\/)\.git(\/|$)/.test(placed.path)) {
    return false;
  }
  return place.anchored || isAbsolute(path.text) || targetKind(word, walk, place) === 'temp';
}

/** Позиционные слова `git worktree add`: `-b`/`-B` и `--reason` берут значение отдельным словом. */
function skipValuedGit(args: Word[]): Word[] {
  const rest: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (/^(-b|-B|--reason)$/.test(text)) i += 1;
    else if (!text.startsWith('-')) rest.push(args[i] as Word);
  }
  return rest;
}

/**
 * `git rm --cached` — только индекс; `git rm пути` — удаление отслеживаемого,
 * восстановимо; без `-f` git сам не удалит файл с правками, с `-f` — сотрёт их.
 */
export function rmVerdict(args: Word[], walk: Walk, place: GitPlace): SegmentVerdict {
  const texts = args.map((arg) => arg.text);
  if (texts.some((text) => /^(-n|--dry-run)$/.test(text))) return ROUTINE;
  const end = texts.indexOf('--');
  const paths = args.filter(
    (arg, i) => (end >= 0 && i > end) || ((end < 0 || i < end) && !arg.text.startsWith('-')),
  );
  if (texts.includes('--cached')) return walk.inCopy(place.cwd) ? ROUTINE : OTHER;
  if (paths.length === 0) return OTHER;
  // Без `-f` git сам откажет, если у файла есть правки: стирать нечего.
  const force = texts.some(
    (text, i) => (end < 0 || i < end) && /^(-[a-z]*f[a-z]*|--force)$/.test(text),
  );
  return overwriteVerdict(paths, walk, place, force);
}

/**
 * `git clean`: пробный прогон — чтение; вне копии — человеку; `-x`/`-X` сносит
 * игнорируемое (`.env`, локальные настройки, то, чего git не вернёт) — тоже
 * человеку; прочее в своей копии — строке «история git», после снимка новых
 * файлов в `refs/agentdeck/backup/…` (решение владельца 23.10).
 */
export function cleanVerdict(args: Word[], inCopy: boolean): SegmentVerdict {
  if (!inCopy) return DANGER;
  if (args.some((arg) => arg.dynamic)) return DANGER;
  const flags = cleanFlags(args);
  if (flags.dryRun) return ROUTINE;
  if (flags.ignored || flags.force > 1) return DANGER;
  noteDiscard('discard');
  return OTHER;
}

/**
 * Ключи `git clean` до `--`: короткие склеиваются (`-fdx`, `-fde '!x'`), `-e`
 * берёт значение склеенным или следующим словом, длинные — с сокращениями.
 * - `ignored`: `-x`/`-X` или исключение с `!` (`-e '!secret.env'` возвращает
 *   игнорируемое в уборку; снимок, как и `git status`, его не видит — A-11);
 * - `force > 1`: `-ff` сносит и вложенные репозитории с их коммитами, которых
 *   снимок не держит (A-13).
 */
function cleanFlags(args: Word[]): { dryRun: boolean; ignored: boolean; force: number } {
  const found = { dryRun: false, ignored: false, force: 0 };
  const exclude = (value: string | undefined) => {
    if (value === undefined || value.startsWith('!')) found.ignored = true;
  };
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (text === '--') break;
    if (text.startsWith('--')) {
      if (longFlag(text, 'dry-run', 2)) found.dryRun = true;
      else if (longFlag(text, 'force', 1)) found.force += 1;
      else if (longFlag(text, 'exclude', 1)) {
        const glued = text.includes('=') ? text.slice(text.indexOf('=') + 1) : undefined;
        exclude(glued ?? args[(i += 1)]?.text);
      }
      continue;
    }
    if (!text.startsWith('-')) continue;
    for (let k = 1; k < text.length; k += 1) {
      const letter = text[k];
      if (letter === 'n') found.dryRun = true;
      else if (letter === 'f') found.force += 1;
      else if (letter === 'x' || letter === 'X') found.ignored = true;
      else if (letter === 'e') {
        exclude(k + 1 < text.length ? text.slice(k + 1) : args[(i += 1)]?.text);
        break;
      }
    }
  }
  return found;
}
