import { execFileSync } from 'node:child_process';
import { ENTER, LEAVE, type Segment, type Step, type Word } from './shell-parse.ts';
import type { Walk } from './walk.ts';
import { writeKind } from './writes.ts';

/**
 * Суд распаковки архива (D-9, 25.10). Стадия ревью группы распаковала дерево
 * базового коммита своей копии (`git archive <sha> … | tar -x -C .agent/tmp/…`)
 * и запустила из него проверку — карточка человеку: путь сквозь распакованное
 * судился как путь через ссылку (RF-BGCD-04), ведь в архиве ссылки могли быть.
 * В архиве `git archive` своей копии — дерево коммита; ссылки в нём видны
 * заранее (`git ls-tree`, режим 120000). Нет их — нет и пути наружу, и
 * распакованное — обычные файлы. Всё, что сверх этого не доказать (иной
 * источник, ключи, меняющие имена и пути, неизвестный каталог оболочки), —
 * прежний суд.
 *
 * Здесь же — куда распаковка пишет: `tar -x` перезаписывает дерево назначения,
 * и вне копии и временного это чужие файлы — человеку.
 */

/** Звено, чей вывод — вход звена трубы (`a | tar`): ключ — слова звена `tar`. */
const feeds = new WeakMap<readonly Word[], readonly Word[]>();

/**
 * Запомнить, что подаётся на вход звена `steps[index]`. Подача доказана, только
 * если слева ровно одно простое звено (`ENTER a LEAVE ENTER |b`): у группы
 * `(cat x.tar; git archive …) | tar -x` поток начинается с чужого архива.
 */
export function noteFeed(steps: readonly Step[], index: number): void {
  const step = steps[index];
  if (typeof step !== 'object' || !step.piped) return;
  const feeder = steps[index - 3];
  if (
    steps[index - 1] === ENTER &&
    steps[index - 2] === LEAVE &&
    typeof feeder === 'object' &&
    steps[index - 4] === ENTER
  ) {
    feeds.set(step.words, (feeder as Segment).words);
  }
}

/** Ссылки в дереве коммита — по одному разу на каталог, коммит и пути (хэш не движется). */
const treeLinks = new Map<string, boolean>();
const HEX_REV = /^[0-9a-f]{7,40}$/i;
const REV = /^[A-Za-z0-9_][\w./^~-]*$/;
/** Путь внутри дерева: без `..`, абсолютного начала, шаблонов и магии путей git. */
const TREE_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(^|\/)\.\.(\/|$))[^*?[\]:\\]+$/;

/** `git archive [--format=tar] <коммит> [пути…]` без иных ключей; иначе `undefined`. */
function ownArchive(words: readonly Word[]): { rev: string; paths: string[] } | undefined {
  if (words.some((word) => word.dynamic)) return undefined;
  if (words[0]?.text !== 'git' || words[1]?.text !== 'archive') return undefined;
  const rest = words.slice(2).map((word) => word.text);
  const operands = rest.filter((text) => text !== '--format=tar');
  const [rev, ...paths] = operands;
  if (rev === undefined || !REV.test(rev) || rev.includes('..')) return undefined;
  if (paths.some((path) => path.startsWith('-') || !TREE_PATH.test(path))) return undefined;
  return { rev, paths };
}

/** Есть ли в дереве `rev` под `paths` ссылка; не прочесть (нет коммита, не git) — есть. */
function hasTreeLinks(cwd: string, rev: string, paths: readonly string[]): boolean {
  const key = `${cwd}\0${rev}\0${paths.join('\0')}`;
  const known = treeLinks.get(key);
  if (known !== undefined) return known;
  let links: boolean;
  try {
    const listing = execFileSync('git', ['ls-tree', '-r', rev, '--', ...paths], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: 256 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    links = /^120000 /m.test(listing);
  } catch {
    links = true;
  }
  // Имя ветки движется — помнить только коммит, названный хэшем.
  if (HEX_REV.test(rev)) treeLinks.set(key, links);
  return links;
}

/**
 * `tar` читает архив со входа и ничего не делает с именами и путями: `x`, `v`,
 * `f -`, `-C`/`--directory`. `-P`, `--transform`, `-h`, свои члены архива и
 * прочее — не доказано, что распакуется только дерево коммита.
 */
function tarPlainStdin(args: readonly Word[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (arg.dynamic) return false;
    const text = arg.text;
    if (text === '-C' || text === '--directory') {
      i += 1;
      continue;
    }
    if (text.startsWith('--directory=') || /^--(extract|verbose)$/.test(text)) continue;
    if (text === '--file=-') continue;
    // Пачка ключей `x`, `xv`, `-xvf`: `f` — последним, его значение — следующее слово.
    const cluster = /^-?([xv]*)(f?)$/.exec(text);
    const file = text === '--file' || cluster?.[2] === 'f';
    if (!file && !(cluster && cluster[1])) return false;
    if (file) {
      if (args[i + 1]?.text !== '-' || args[i + 1]?.dynamic) return false;
      i += 1;
    }
  }
  return true;
}

/**
 * Звено `tar` распаковывает дерево коммита своей копии без ссылок: подача —
 * `git archive` того же каталога оболочки (известного, в копии, без подмены git
 * переменными, псевдонимом или функцией), ключи `tar` имён не меняют.
 * `raw` — слова звена, как их отдал разбор (ключ подачи).
 */
export function linkFreeUnpack(
  name: string,
  words: readonly Word[],
  raw: readonly Word[],
  walk: Walk,
): boolean {
  if (name !== 'tar' && name !== 'bsdtar' && name !== 'gtar') return false;
  const feeder = feeds.get(raw);
  const archive = feeder && ownArchive(feeder);
  if (!archive || !tarPlainStdin(words.slice(1))) return false;
  if (walk.gitEnv || Object.hasOwn(walk.aliases ?? {}, 'git')) return false;
  if (Object.hasOwn(walk.functions ?? {}, 'git')) return false;
  const place = walk.place();
  if (!place.cwd || place.guessed || !walk.inCopy(place.cwd)) return false;
  return !hasTreeLinks(place.cwd, archive.rev, archive.paths);
}

/**
 * Распаковка пишет вне своей копии и временного — человеку: `tar -x -C ../x`
 * перезапишет чужое дерево. Каталог, который не узнать (`jar x`, `cpio -i`),
 * судит учёт ссылок, как прежде.
 */
export function unpackLeaves(dirs: readonly (Word | undefined)[], walk: Walk): boolean {
  return dirs.some((dir) => {
    if (dir === undefined) return false;
    const kind = writeKind(dir, walk);
    return kind !== 'inside' && kind !== 'temp';
  });
}
