import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProjectWorktree, ProjectWorktreesInfo } from '@claude-control/contracts';
import { GIT_NETWORK_TIMEOUT_MS } from './constants.ts';
import { git, GitError } from './exec.ts';
import { isGitRepo, requireRepo } from './read.ts';
import { assertBranchName } from './write.ts';

/**
 * Параллельные рабочие копии (`git worktree`) — то, чем несколько агентов
 * работают над одним репозиторием одновременно и не мешают друг другу: у каждой
 * копии свой каталог и своя ветка, а история и объекты общие.
 *
 * Три правила, из которых сделано всё остальное.
 *
 * 1. КОПИЯ НЕ ПРИНАДЛЕЖИТ ВЕТКЕ. Внутри копии агент волен переключаться,
 *    заводить ветки и тянуть чужое — панель это не запрещает и не отслеживает.
 *    Поэтому ветка копии всюду читается заново из `worktree list`, а не хранится
 *    с момента создания: сохранённая — соврала бы при первом же `checkout`.
 * 2. КОПИИ ЖИВУТ РЯДОМ С РЕПОЗИТОРИЕМ, а не внутри него:
 *    `<родитель>/<имя-репозитория>-worktrees/<ветка>`. Внутри рабочего дерева их
 *    держать нельзя — сборщики, линтеры и наблюдатели файлов немедленно приняли
 *    бы копию за часть проекта и пошли бы по ней рекурсивно.
 * 3. УДАЛЯЕТСЯ ТОЛЬКО ТО, ЧТО ПЕРЕЧИСЛИЛ САМ GIT. Путь на удаление сверяется со
 *    списком копий этого репозитория, а основная копия не удаляется вовсе —
 *    иначе кнопка «убрать» дотянулась бы до любого каталога на диске.
 *
 * Слияния здесь нет намеренно и это решение владельца: свести ветку обратно —
 * его собственный шаг, панель такую кнопку не показывает. Всё остальное
 * (коммит, pull в свою ветку, разбор конфликтов) агент делает сам обычными
 * командами git — ему это не запрещено.
 */

/** Путь в сравнимом виде: слэши в одну сторону, регистр — как решает система. */
function samePath(a: string, b: string): boolean {
  const norm = (value: string): string => {
    const text = resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? text.toLowerCase() : text;
  };
  return norm(a) === norm(b);
}

/**
 * Имя каталога из имени ветки: `feature/parallel` → `feature-parallel`. Буквы
 * любого алфавита остаются как есть (кириллическая ветка — обычное дело), а всё,
 * что путает файловую систему, схлопывается в дефис.
 */
export function worktreeDirName(name: string): string {
  const safe = name
    .replace(/[\\/]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  // Пустое имя оставило бы каталог без названия, а зарезервированные имена
  // Windows (CON, PRN, COM1…) не создаются вовсе — обе беды лечит суффикс.
  if (!safe) return 'wt';
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe) ? `${safe}-wt` : safe;
}

/**
 * Суффикс соседнего каталога с копиями. Вынесен в константу, потому что по
 * этому же имени копию узнаёт привязка групп к проекту (`group-activation.ts`):
 * копия лежит РЯДОМ с репозиторием, и обычной проверкой «путь внутри проекта»
 * она не ловится.
 */
export const WORKTREES_DIR_SUFFIX = '-worktrees';

/** Куда ляжет копия ветки: соседний каталог `<репозиторий>-worktrees`. */
export function worktreeDirFor(mainPath: string, name: string): string {
  const main = resolve(mainPath);
  return join(dirname(main), `${basename(main)}${WORKTREES_DIR_SUFFIX}`, worktreeDirName(name));
}

/**
 * Разбор `git worktree list --porcelain`. Записи разделены пустой строкой,
 * первая — всегда основная копия (так их перечисляет git), поэтому `isMain`
 * ставится по порядку, а не угадывается по путям.
 */
export function parseWorktrees(stdout: string): ProjectWorktree[] {
  const list: ProjectWorktree[] = [];
  let current: ProjectWorktree | undefined;

  const flush = (): void => {
    if (current) list.push(current);
    current = undefined;
  };

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = {
        path: line.slice('worktree '.length).trim(),
        isMain: list.length === 0,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim().slice(0, 8);
    else if (line.startsWith('branch ')) {
      current.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    } else if (line === 'detached') current.detached = true;
    // У `locked` и `prunable` бывает причина через пробел — она нас не занимает,
    // важен сам факт: заперта или ждёт уборки.
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true;
  }
  flush();

  // Пути от git всегда со слэшами вперёд, даже в Windows: приводим к виду
  // системы, потому что этим же путём открывается вкладка и запускается агент.
  return list.map((item) => ({ ...item, path: resolve(item.path) }));
}

/** Копии репозитория. Бросает GitError — для маршрута есть `listWorktrees`. */
async function readWorktrees(projectDir: string): Promise<ProjectWorktree[]> {
  return parseWorktrees(await git(projectDir, ['worktree', 'list', '--porcelain']));
}

/**
 * Список копий для клиента. Как и `readProjectGit`, ошибкой запроса не отвечает:
 * не репозиторий — `isRepo:false`, сломанный git — `error` с его текстом.
 */
export async function listWorktrees(projectDir: string): Promise<ProjectWorktreesInfo> {
  if (!isGitRepo(projectDir)) return { isRepo: false, worktrees: [] };
  try {
    return { isRepo: true, worktrees: await readWorktrees(projectDir) };
  } catch (error) {
    return {
      isRepo: true,
      worktrees: [],
      error: error instanceof GitError ? error.message : String(error),
    };
  }
}

/**
 * Завести копию под ветку. Имя ветки решает, что именно произойдёт, и это
 * ровно то, чего ждёшь от git:
 *
 * - ветка есть локально → копия встаёт на неё (git сам откажет, если она уже
 *   занята другой копией — двух рабочих деревьев на одной ветке не бывает);
 * - ветки нет локально, но есть на удалённом → заводим её от `<remote>/<имя>`
 *   с отслеживанием: так разбирают чужую ветку из merge request;
 * - нет нигде → новая ветка от HEAD того каталога, откуда позвали.
 *
 * Потолок ожидания сетевой: `worktree add` разворачивает всё дерево файлов, и
 * на большом репозитории это дольше обычной локальной команды.
 */
export async function addWorktree(
  projectDir: string,
  name: string,
): Promise<{ path: string; output: string }> {
  const info = await requireRepo(projectDir);
  if (info.unborn) {
    throw new GitError('В репозитории ещё нет коммитов — сначала сделайте первый коммит');
  }
  const value = name.trim();
  await assertBranchName(projectDir, value);

  const list = await readWorktrees(projectDir);
  const main = list[0];
  if (!main) throw new GitError('git не назвал ни одной рабочей копии');

  const busy = list.find((item) => item.branch === value);
  if (busy) {
    throw new GitError(
      busy.isMain
        ? `Ветка ${value} занята основной копией — заведите копию под другую ветку`
        : `Ветка ${value} уже открыта копией ${busy.path}`,
    );
  }

  const target = worktreeDirFor(main.path, value);
  if (list.some((item) => samePath(item.path, target))) {
    throw new GitError(`Копия ${target} уже есть — откройте её вкладкой`);
  }
  if (existsSync(target)) {
    throw new GitError(`Каталог ${target} уже существует — выберите другое имя ветки`);
  }

  const args = info.branches.includes(value)
    ? ['worktree', 'add', target, value]
    : info.remote && info.remoteBranches.includes(value)
      ? ['worktree', 'add', '--track', '-b', value, target, `${info.remote}/${value}`]
      : ['worktree', 'add', '-b', value, target];

  const out = await git(projectDir, args, GIT_NETWORK_TIMEOUT_MS);
  return {
    path: resolve(target),
    output: out.trim() || `Копия ${target} готова на ветке ${value}`,
  };
}

/**
 * Убрать копию. Путь обязан быть из списка копий ЭТОГО репозитория, основная не
 * удаляется никогда. Пропавший каталог (`prunable`) не удаляют, а подчищают
 * `prune`: удалять там уже нечего, а запись в git осталась.
 *
 * Незакоммиченные правки внутри копии git не отдаст без `--force` — и правильно
 * сделает: это чужая работа, а не мусор. Его отказ уходит человеку как есть.
 */
export async function removeWorktree(
  projectDir: string,
  target: string,
  force = false,
): Promise<string> {
  await requireRepo(projectDir);
  const list = await readWorktrees(projectDir);
  const entry = list.find((item) => samePath(item.path, target));
  if (!entry) throw new GitError('Такой рабочей копии в этом репозитории нет');
  if (entry.isMain) throw new GitError('Это основная рабочая копия — её удалить нельзя');

  if (entry.prunable) {
    await git(projectDir, ['worktree', 'prune']);
    return `Каталога копии больше нет — запись убрана`;
  }

  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), entry.path];
  const out = await git(projectDir, args, GIT_NETWORK_TIMEOUT_MS);
  return out.trim() || `Копия ${entry.path} убрана`;
}
