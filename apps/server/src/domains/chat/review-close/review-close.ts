import { realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorktreeMirrorSettings } from '@agentdeck/contracts';
import type { SplitGroupReviewClose } from '@agentdeck/contracts/chat-handoff';
import { normalizeProjectPath } from '../../../lib/app-store/projects.ts';
import type { DockerExec } from '../../compose/docker.ts';
import { git } from '../../project-git/exec/exec.ts';
import { effectiveSettings, LINK_DIRS, wanted } from '../../project-git/mirror-local.ts';
import { listWorktrees, removeWorktree } from '../../project-git/worktrees.ts';
import { removeReviewStand, type ReviewStandContainer } from '../review-stand/review-stand.ts';

/**
 * Закрытие группы ревью (T13, T6/T11): что осталось в копии и рядом с ней.
 *
 * Ревью по ссылке «ничего не правит», но живая группа на MR 988 оставила дерево
 * грязным (карточка об этом молчала), завела временный клон под линии ревью
 * (каталог остался, когда линии дописали в него после «уборки») и подняла бы
 * одноразовую базу. Здесь три факта вместо слов агента:
 *
 * - `dirt` — `git status` копии: правки и неотслеженные файлы, кроме того, что
 *   панель кладёт сама (локальный слой, `node_modules`, `.venv`);
 * - временные копии, заведённые группой после её старта, снимаются — но только
 *   те, чью работу терять нечем: без правок отслеживаемого и с головой, которая
 *   достижима из какой-нибудь ветки. Остальные остаются и названы на карточке;
 * - одноразовая база ревью снимается.
 *
 * Чужого не трогаем: копии групп панели, основную копию, запертые копии и
 * всё, что с веткой, — только отчёт. Ничего не бросает: сбой записывается в
 * причину, а группа закрывается как закрывалась.
 */

/** Сколько имён на карточке. */
export const DIRT_FILES_MAX = 20;

/** Каталоги, которые панель ставит копии сама и которые «правкой» не считаются. */
const PANEL_DIRS = ['node_modules', '.venv', 'venv'] as const;

const underPanelDir = (path: string): boolean =>
  PANEL_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`) || path.includes(`/${dir}/`));

/** Пути из `git status --porcelain -z`; у переименования следом идёт прежний путь — пропускаем его. */
export function statusPaths(stdout: string): string[] {
  const entries = stdout.split('\0');
  const paths: string[] = [];
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at] as string;
    if (entry.length <= 3) continue;
    paths.push(entry.slice(3).replace(/\\/g, '/'));
    if (entry[0] === 'R' || entry[0] === 'C') at += 1;
  }
  return paths;
}

/** Правки копии, не считая того, что панель положила сама. */
export async function copyDirt(
  copy: string,
  mirror: WorktreeMirrorSettings | undefined,
): Promise<{ total: number; files: string[] } | undefined> {
  let status: string;
  try {
    status = await git(copy, ['status', '--porcelain', '-z', '-uall']);
  } catch {
    return undefined;
  }
  const settings = effectiveSettings(mirror);
  const own = (path: string): boolean =>
    underPanelDir(path) ||
    wanted(path, settings) ||
    LINK_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
  const paths = statusPaths(status).filter((path) => !own(path));
  return { total: paths.length, files: paths.slice(0, DIRT_FILES_MAX) };
}

/**
 * Ключ копии по НАСТОЯЩЕМУ пути: `git worktree list` раскрывает ссылки, а панель
 * помнит копию по пути через ссылку (корень за symlink, `/tmp` на macOS) — своя
 * копия группы читалась бы чужой. Каталога уже нет — путь как есть.
 */
const norm = (path: string): string => {
  const full = resolve(path);
  try {
    return normalizeProjectPath(realpathSync.native(full));
  } catch {
    return normalizeProjectPath(full);
  }
};

/** Когда копию завели: время указателя `.git` в её корне — он пишется один раз. */
function createdAt(path: string): number | undefined {
  try {
    return statSync(join(path, '.git')).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Достижима ли голова копии из какой-нибудь ветки: иначе её коммиты живут только здесь. */
async function headReachable(path: string): Promise<boolean> {
  try {
    const refs = await git(path, [
      'for-each-ref',
      '--contains',
      'HEAD',
      '--format=%(refname)',
      'refs/heads',
      'refs/remotes',
    ]);
    return refs.trim().length > 0;
  } catch {
    return false;
  }
}

async function trackedChanges(path: string): Promise<boolean> {
  try {
    return (await git(path, ['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
  } catch {
    return true;
  }
}

export interface ReviewCloseInput {
  /** Верх репозитория, от которого заведены копии. */
  mainDir: string;
  /** Копия группы. */
  copy?: string;
  /** Когда группа стартовала (ISO): копии старше этого не её. */
  startedAt?: string;
  /** Копии всех групп панели — они не «временные». */
  knownCopies: readonly string[];
  mirror?: WorktreeMirrorSettings;
  /** `false` — `git status` копии не нужен: группа правила по решению человека. */
  dirt?: boolean;
  stand?: Pick<ReviewStandContainer, 'name'>;
}

export interface ReviewCloseDeps {
  docker: DockerExec;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

/** Временные копии группы: снять безопасные, назвать остальные. */
async function sweepScratch(
  input: ReviewCloseInput,
  deps: ReviewCloseDeps,
): Promise<{ removed: string[]; kept: { path: string; why: string }[] }> {
  const removed: string[] = [];
  const kept: { path: string; why: string }[] = [];
  const since = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  if (!Number.isFinite(since)) return { removed, kept };
  const listing = await listWorktrees(input.mainDir);
  const known = new Set([...input.knownCopies, ...(input.copy ? [input.copy] : [])].map(norm));

  for (const entry of listing.worktrees) {
    if (entry.isMain || known.has(norm(entry.path))) continue;
    const born = createdAt(entry.path);
    // Старше группы или без указателя — не наша: человек завёл сам или каталога нет.
    if (born === undefined || born < since) continue;
    if (entry.locked) {
      kept.push({ path: entry.path, why: 'locked' });
      continue;
    }
    if (entry.branch) {
      kept.push({ path: entry.path, why: `on the branch ${entry.branch}` });
      continue;
    }
    if (await trackedChanges(entry.path)) {
      kept.push({ path: entry.path, why: 'has uncommitted changes to tracked files' });
      continue;
    }
    if (!(await headReachable(entry.path))) {
      kept.push({ path: entry.path, why: 'its commits are on no branch' });
      continue;
    }
    try {
      await removeWorktree(input.mainDir, entry.path, true, undefined, input.mirror);
      removed.push(entry.path);
    } catch (error) {
      deps.log?.('review close: scratch copy not removed', error);
      kept.push({
        path: entry.path,
        why: error instanceof Error ? error.message.split('\n')[0]!.slice(0, 160) : 'not removed',
      });
    }
  }
  return { removed, kept };
}

/**
 * Итог закрытия группы ревью. `undefined` — нечего сказать: копия чиста, ничего
 * не заводилось, базы не было.
 */
export async function closeReviewGroup(
  input: ReviewCloseInput,
  deps: ReviewCloseDeps,
): Promise<SplitGroupReviewClose | undefined> {
  const now = deps.now ?? (() => new Date());
  const out: SplitGroupReviewClose = { at: now().toISOString() };

  if (input.copy && input.dirt !== false) {
    const dirt = await copyDirt(input.copy, input.mirror).catch(() => undefined);
    if (dirt && dirt.total > 0) out.dirt = dirt;
  }
  try {
    const swept = await sweepScratch(input, deps);
    if (swept.removed.length > 0) out.scratchRemoved = swept.removed;
    if (swept.kept.length > 0) out.scratchKept = swept.kept;
  } catch (error) {
    deps.log?.('review close: scratch sweep failed', error);
  }
  if (input.stand) {
    const gone = await removeReviewStand(deps.docker, input.stand.name, input.mainDir).catch(
      () => false,
    );
    if (gone) out.standRemoved = true;
  }
  const quiet = !out.dirt && !out.scratchRemoved && !out.scratchKept && !out.standRemoved;
  return quiet ? undefined : out;
}
