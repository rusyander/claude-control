import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git } from './exec/exec.ts';
import { parseDirtyPaths } from './read.ts';

/**
 * Lock-файлы, которые установка зависимостей переписывает у себя под ногами.
 *
 * Установка в копии идёт в режиме `ci` / `--frozen-lockfile`, и в норме дерево
 * после неё чистое. Но менеджер пакетов другой версии, чем у автора lock-файла,
 * переписывает его «под себя» даже в замороженном режиме (pnpm меняет
 * `lockfileVersion`, npm пересобирает `packages`), а команда проекта может и
 * не быть замороженной. Первый ход агента в такой копии — откат этого файла,
 * иначе он уедет в коммит: так и было на живом разделении 09.09.2026.
 */
export const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

/**
 * Где искать: в корне и в каталогах первого уровня — там же, где бутстрап
 * находит lock-файл (Д13). `*` в `:(glob)` не переходит через `/`, так что
 * глубже первого уровня не смотрим.
 */
/**
 * Манифесты языков вне Node, которые подготовка копии переписывает сама:
 * `go mod download` дописывает `go.sum` и правит `go.mod` (разбор остановок
 * 23.10, D5: две группы получили «не закоммичено: go.mod» в каталогах, которых
 * их задача не касалась, — правку сделала подготовка панели, не агент).
 */
const PREP_MANIFESTS = ['go.mod', 'go.sum', 'uv.lock'] as const;

const LOCKFILE_PATHSPECS = [...LOCKFILES, ...PREP_MANIFESTS].flatMap((name) => [
  name,
  `:(glob)*/${name}`,
]);

/**
 * Разбор `git status --porcelain -z`: путь и то, отслеживается ли файл.
 * Формат: два символа статуса, пробел, путь; переименования (`R`) в списке
 * lock-файлов не встречаются — их `git status` для явных путей не показывает.
 */
export function parseChurn(stdout: string): Array<{ path: string; tracked: boolean }> {
  return stdout
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => ({ path: entry.slice(3), tracked: !entry.startsWith('??') }));
}

/**
 * Вернуть lock-файлы копии к версии из индекса; появившиеся заново — убрать.
 * Возвращает, что откатилось, — для лога установки и карточки копии. Копия
 * без git (или git без ответа) — ничего не трогаем: откатывать неоткуда.
 * `keep` — пути, грязные ещё до подготовки (F-64): это правка агента, её не трогаем.
 */
export async function revertLockfileChurn(
  dir: string,
  keep: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  let status: string;
  try {
    status = await git(dir, ['status', '--porcelain', '-z', '--', ...LOCKFILE_PATHSPECS]);
  } catch {
    return [];
  }
  const churn = parseChurn(status).filter((item) => !keep.has(item.path));
  if (churn.length === 0) return [];

  const tracked = churn.filter((item) => item.tracked).map((item) => item.path);
  if (tracked.length > 0) {
    await git(dir, ['checkout', '--', ...tracked]);
  }
  for (const item of churn.filter((entry) => !entry.tracked)) {
    await rm(join(dir, item.path), { force: true });
  }
  return churn.map((item) => item.path);
}

/** Грязные пути копии до подготовки; `unknown` — снимок не вышел (`snapshotPrepTree`). */
const prepBefore = new Map<string, ReadonlySet<string> | 'unknown'>();

function recordKey(dir: string): string {
  const path = resolve(dir).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function dirtyNow(dir: string): Promise<string[] | undefined> {
  try {
    return parseDirtyPaths(await git(dir, ['status', '--porcelain=v1', '-z', '-uall']));
  } catch {
    return undefined;
  }
}

/**
 * Грязное копии ПЕРЕД подготовкой (F-64): повторная установка в копии посреди
 * работы иначе откатывала go.mod/go.sum/lock-файл агента. Снимок не вышел —
 * `false`: тогда конец подготовки не откатывает ничего.
 */
export async function snapshotPrepTree(dir: string): Promise<boolean> {
  const dirty = await dirtyNow(dir);
  if (!dirty) {
    prepBefore.set(recordKey(dir), 'unknown');
    return false;
  }
  prepBefore.set(recordKey(dir), new Set(dirty));
  return true;
}

/**
 * Конец подготовки копии: откат переписанных lock-файлов и манифестов.
 * Возвращает откаченное — для лога и карточки, как `revertLockfileChurn`.
 *
 * Снимок до подготовки (`snapshotPrepTree`) есть — откатывается только то, что
 * до неё было чистым (F-64); снимок не вышел — не трогаем ничего. Снимка
 * нет вовсе (свежая копия разделения) — дерево до подготовки считается чистым.
 */
export async function settlePrepTree(dir: string): Promise<string[]> {
  const key = recordKey(dir);
  const before = prepBefore.get(key);
  prepBefore.delete(key);
  if (before === 'unknown') return [];
  return revertLockfileChurn(dir, before);
}

/**
 * Обвязка подготовки копии для `WorktreeBootstraps`: снимок до команды и
 * откат после. Одна на все пути запуска — кнопка карточки, создание
 * копии и подготовка копии группы снимают дерево одинаково: прежде
 * снимок делал только маршрут кнопки, а повторная подготовка группы в копии с
 * работой агента считала дерево чистым и откатывала его lock-файл (F-64).
 */
export const PREP_TREE_HOOKS = {
  beforeRun: snapshotPrepTree,
  afterRun: settlePrepTree,
} as const;
