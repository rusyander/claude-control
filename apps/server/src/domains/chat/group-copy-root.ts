import { existsSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { git } from '../project-git/exec/exec.ts';
import { WORKTREES_DIR_SUFFIX } from '../project-git/worktrees.ts';
import { isProtectedBranch } from './group-command/branch.ts';
import { canonical, real } from './group-command/paths.ts';

/**
 * Корень копии группы по каталогу её прогона. Прогон группы в монорепозитории
 * стоит в подпроекте копии (`…-worktrees/feat-x/inst-config`), а копия — вся
 * `feat-x`: судить от подпроекта значило считать `cd ..`, `git -C <корень>` и
 * `git rebase` в корне «записью вне своей копии» (A-03) — 52 вызова групп
 * уходили человеку (повтор `check-group-asks-replay`, 23.10).
 *
 * Корень — ближайший предок с `.git` (каталог или файл копии ветки). Нет
 * такого (каталог уже удалён) — копия панели по её же раскладке
 * `<репозиторий>-worktrees/<каталог>` (`worktreeDirFor`); иначе сам каталог.
 */
export function copyRootOf(cwd: string, exists: (path: string) => boolean = existsSync): string {
  let dir = cwd;
  for (;;) {
    if (exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const parts = cwd.split(/[\\/]/);
  const at = parts.findIndex(
    (part, i) => i < parts.length - 1 && part.toLowerCase().endsWith(WORKTREES_DIR_SUFFIX),
  );
  if (at < 0) return cwd;
  const separator = cwd.includes('\\') ? '\\' : cwd.includes('/') ? '/' : sep;
  return parts.slice(0, at + 2).join(separator);
}

/** Чтение списка копий репозитория — шов для теста и повтора; по умолчанию живой git. */
export interface WorktreeListIo {
  /** `git worktree list --porcelain` в `root`; `undefined` — git не ответил. */
  list(root: string): Promise<string | undefined>;
}

export const realWorktreeListIo: WorktreeListIo = {
  list: (root) => git(root, ['worktree', 'list', '--porcelain'], 5_000).catch(() => undefined),
};

interface WorktreeEntry {
  path: string;
  /** `refs/heads/<имя>`; нет — HEAD отсоединена или репозиторий голый. */
  branch?: string;
  /** Строка `prunable`: папки копии нет, `git worktree prune` уберёт её запись. */
  prunable: boolean;
}

function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of porcelain.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!path) continue;
    // Голый репозиторий остаётся в списке первым: без строки `branch` он не совпадёт.
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
    const prunable = lines.some((line) => line === 'prunable' || line.startsWith('prunable '));
    entries.push({ path, ...(branch ? { branch } : {}), prunable });
  }
  return entries;
}

/**
 * Копии, чьи записи снесёт `git worktree prune` сейчас (RF-BGCD-03): папки нет,
 * запись осталась. `undefined` — git не ответил: что снесётся, не знаем.
 */
export async function prunableWorktrees(
  root: string,
  io: WorktreeListIo = realWorktreeListIo,
): Promise<string[] | undefined> {
  const porcelain = await io.list(root);
  if (porcelain === undefined) return undefined;
  return parseWorktreeList(porcelain)
    .filter((entry) => entry.prunable)
    .map((entry) => entry.path);
}

const samePath = (a: string, b: string): boolean => {
  if (canonical(a) === canonical(b)) return true;
  const [ra, rb] = [real(a), real(b)];
  return Boolean(ra && rb && ra === rb);
};

/**
 * Своя копия группы, чей прогон записан в ОСНОВНОЙ копии (повтор 23.10: группа
 * в `C:/work/shop` делала `cd ../shop-worktrees/<своя> && git push -u origin
 * <своя ветка>`, и пуш уходил человеку — копией считалась основная). Своя —
 * копия ветки, которую ЭТОТ репозиторий перечисляет сейчас (`git worktree list`,
 * живьём, без памяти) и чья ветка — ветка записи разделения. Основная копия
 * своей этим правилом не становится никогда: она первая в списке и в поиск не
 * входит. Ветки записи нет, она защищена, копия отсоединена или на другой
 * ветке — совпадения нет, и ничего не расширяется (`undefined`).
 */
export async function recordBranchCopy(
  root: string,
  recordBranch: string | undefined,
  io: WorktreeListIo = realWorktreeListIo,
): Promise<string | undefined> {
  if (!recordBranch || isProtectedBranch(recordBranch)) return undefined;
  // Основная копия держит `.git` каталогом; у копии ветки `.git` — файл.
  // Без каталога git не спрашиваем: прогон и так в копии ветки.
  try {
    if (!statSync(join(root, '.git')).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const porcelain = await io.list(root);
  if (!porcelain) return undefined;
  const [main, ...linked] = parseWorktreeList(porcelain);
  if (!main || !samePath(main.path, root)) return undefined;
  const wanted = `refs/heads/${recordBranch}`;
  return linked.find((entry) => entry.branch === wanted)?.path;
}
