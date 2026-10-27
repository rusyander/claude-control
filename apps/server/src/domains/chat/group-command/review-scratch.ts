import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { canonical, escapesBase, real, resolveFrom, within } from './paths.ts';

/**
 * Клон рецензента, который сделал `review-plan.mjs plan` (D-5 26.10): `git clone
 * --shared --no-checkout` из копии в `<TEMP>/claude-review/review-<slug>/clone`,
 * затем метка `<клон>/.git/review-plan-scratch.json` — её пишут только после
 * удавшегося клона. Подагент-рецензент проверяет находку правкой в клоне и
 * убирает пробу; удаление пробного файла там уходило человеку, хотя в клоне
 * нет ничего, кроме того, что git вернёт из копии.
 *
 * Клон признаётся только по метке на диске: JSON со строковыми `source` и `head`,
 * свой `.git/HEAD`, `source` — другой каталог. Решает ближайшая метка вверх по
 * пути; битая — не клон. Ссылки, что план завёл в клоне (`links`, `node_modules`
 * в настоящую копию), и всё, что уходит из клона по ссылке, — не клон.
 */
const MARK = 'review-plan-scratch.json';
/** Предел подъёма к метке: глубже путей не бывает, а цикл не бесконечен. */
const MAX_UP = 64;

export interface ReviewMark {
  /** Корень клона, в написании пути, от которого искали. */
  root: string;
  source: string;
  links: string[];
}

type Found = ReviewMark | 'none' | 'bad';

function readMark(dir: string): Found {
  const base = dir.replace(/\/$/, '');
  const file = `${base}/.git/${MARK}`;
  if (!existsSync(file)) return 'none';
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return 'bad';
    const { source, head, links } = parsed as Record<string, unknown>;
    if (typeof source !== 'string' || !source || typeof head !== 'string' || !head) return 'bad';
    if (links !== undefined && !Array.isArray(links)) return 'bad';
    if (!existsSync(`${base}/.git/HEAD`)) return 'bad';
    const named = (links ?? []).filter((link): link is string => typeof link === 'string');
    return { root: dir, source: canonical(source), links: named.map(canonical) };
  } catch {
    // Не прочесть или не разобрать — не клон.
    return 'bad';
  }
}

function parentOf(dir: string): string {
  const cut = dir.lastIndexOf('/');
  if (cut <= 0) return '/';
  const up = dir.slice(0, cut);
  return /^[a-z]:$/.test(up) ? `${up}/` : up;
}

/** Метка клона review-plan, под которым лежит путь, — или `undefined`. */
export function reviewScratchMark(path: string): ReviewMark | undefined {
  let dir = canonical(path);
  for (let step = 0; step < MAX_UP; step += 1) {
    const found = readMark(dir);
    if (found === 'bad') return undefined;
    if (found !== 'none') return found;
    const up = parentOf(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/**
 * Основная копия связанной рабочей копии: её `.git` — файл `gitdir:
 * <основная>/.git/worktrees/<имя>`. `undefined` — `.git` нет или это каталог
 * (копия сама основная), `null` — файл есть, но основную по нему не найти.
 */
export function mainCopyOf(worktree: string): string | undefined | null {
  const file = `${canonical(worktree).replace(/\/$/, '')}/.git`;
  try {
    if (statSync(file).isDirectory()) return undefined;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(file, 'utf8'));
    if (!pointer) return null;
    const gitDir = resolveFrom(canonical(worktree), pointer[1] as string);
    const linked = /^(.*)\/worktrees\/[^/]+$/.exec(gitDir);
    if (!linked) return null;
    return (linked[1] as string).replace(/\/\.git$/, '');
  } catch {
    return existsSync(file) ? null : undefined;
  }
}

const spellings = (path: string): string[] => [
  ...new Set([path, real(path)].filter((entry): entry is string => Boolean(entry))),
];

function linkExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Путь — внутри клона review-plan, и клон не задевает настоящее: корень клона
 * не корень диска, не дом и не над ним, не внутри и не над копией группы,
 * основной копией и источником клона (`fence` — копия и основная под обоими
 * написаниями; `undefined` — основную не прочесть, клоном не считается ничто).
 * Цель внутри ссылки плана или над живой ссылкой (`rm -rf` клона, пока
 * `node_modules` ведёт в копию) и путь, уходящий из клона по ссылке, — не клон.
 * `aboveLinks` — каталог git, а не цель удаления: git по ссылкам не ходит, и
 * каталог над ними клоном остаётся (`git clean` судит `holdsReviewLinks`).
 */
export function inReviewScratch(
  path: string,
  fence: readonly string[] | undefined,
  follow: boolean,
  aboveLinks = false,
): boolean {
  if (fence === undefined) return false;
  const mark = reviewScratchMark(path);
  if (!mark) return false;
  const own = spellings(mark.root);
  const kept = [...fence, ...spellings(mark.source)];
  const home = spellings(canonical(homedir()));
  for (const root of own) {
    if (/^([a-z]:)?\/$/.test(root)) return false;
    if (home.some((entry) => within(entry, root))) return false;
    if (kept.some((entry) => within(entry, root) || within(root, entry))) return false;
  }
  const target = canonical(path);
  for (const link of mark.links) {
    if (within(target, link)) return false;
    if (!aboveLinks && within(link, target) && linkExists(link)) return false;
  }
  return !escapesBase(target, mark.root, follow);
}

/** Под путём лежит живая ссылка плана (`node_modules` клона ведёт в настоящую копию). */
export function holdsReviewLinks(path: string): boolean {
  const mark = reviewScratchMark(path);
  if (!mark) return false;
  const target = canonical(path);
  return mark.links.some((link) => within(link, target) && linkExists(link));
}
