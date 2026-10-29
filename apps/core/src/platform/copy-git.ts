import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { GitOptions, WorktreeAdd } from './git/git.types.ts';
import { withNoHooks } from './git/no-hooks.ts';
import { C_LOCALE, dirOccupied, dropAddedWorktree } from './git/worktree.ts';
import { git } from './git/run.ts';
import { currentOs, reasonOf, type OsKind } from './os-kind.ts';
import { longForm, samePath } from './paths.ts';
import { listWorktrees } from './resource-scan.ts';
import { removeVerified } from './safe-io/remove.ts';

/**
 * git копий единицы (04:97-99, G7): ветка от закреплённой базы, состояние копии для сверки,
 * длинные пути, списки локального слоя, флаги, откат lock-файлов, удаление с чтением назад.
 * Перенесено из панели (`project-git/worktrees.ts`, `mirror-local.ts`, `lockfiles.ts`); правила
 * (что зеркалить, что откатывать) — у дирижёра (`conductor/copy`), здесь только git и диск.
 */

const T = { short: 30_000, long: 300_000 };

export type CopyGitOptions = GitOptions;

/** sha коммита ревизии; нет такой — `absent`, git не ответил — `unknown`. */
export async function commitOf(
  repo: string,
  ref: string,
  options: CopyGitOptions = {},
): Promise<Fact<string>> {
  try {
    const out = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      ...options,
      timeoutMs: T.short,
      acceptNonZero: true,
    });
    const sha = out.stdout.trim();
    return out.code === 0 && sha ? { value: sha } : { absent: true };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

/** Ветка, выложенная в каталоге (`absent` — отцепленный HEAD). */
export async function currentBranch(
  dir: string,
  options: CopyGitOptions = {},
): Promise<Fact<string>> {
  try {
    const out = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      ...options,
      timeoutMs: T.short,
      acceptNonZero: true,
    });
    const name = out.stdout.trim();
    return out.code === 0 && name ? { value: name } : { absent: true };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

/**
 * Копия на ветке единицы. Ветки нет — заводится от `base` без слежения (`--no-track`: ветка
 * агента не «отстаёт» от базы в глазах git); есть — копия её и берёт (повтор после краха).
 * Хуки проекта при выкладке не идут (как `addDetachedWorktree`): post-checkout чужого проекта —
 * не наш побочный эффект. Выкладка упала посреди — убирается ровно созданное этой попыткой.
 */
export async function addBranchWorktree(
  repo: string,
  dir: string,
  branch: string,
  base: string,
  options: CopyGitOptions = {},
): Promise<WorktreeAdd> {
  const call = { ...options, timeoutMs: T.long, extraEnv: C_LOCALE };
  let created = false;
  const occupied = dirOccupied(dir);
  try {
    const has = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      ...call,
      acceptNonZero: true,
    });
    if (has.code !== 0) created = true;
    await withNoHooks((hooks) =>
      has.code === 0
        ? git(repo, [...hooks, 'worktree', 'add', '--quiet', dir, branch], call)
        : git(
            repo,
            [...hooks, 'worktree', 'add', '--quiet', '--no-track', '-b', branch, dir, base],
            call,
          ),
    );
    const head = await git(dir, ['rev-parse', '--verify', 'HEAD'], {
      ...options,
      timeoutMs: T.short,
    });
    return { created: dir, head: head.stdout.trim() };
  } catch (error) {
    // Занятый до вызова каталог — не наша выкладка: снимается только созданная этим вызовом ветка.
    // Свободный до вызова, но занятый соседом между проверкой и add (две ветки на одно имя
    // каталога) — тоже не наш: дерево снимается, только если в нём НАША ветка.
    const ours = !occupied && (await addedHere(dir, branch, options));
    await undoFailedAdd(ours ? dir : undefined, repo, created ? branch : undefined, options);
    return { failed: reasonOf(error) };
  }
}

/** Каталог после упавшего add — выкладка этой попытки: его нет (снимать нечего, только prune) или в нём наша ветка. */
async function addedHere(dir: string, branch: string, options: CopyGitOptions): Promise<boolean> {
  const state = copyState(dir);
  if ('absent' in state || ('value' in state && state.value === 'empty')) return true;
  const on = await currentBranch(dir, options);
  return 'value' in on && on.value === branch;
}

async function undoFailedAdd(
  dir: string | undefined,
  repo: string,
  createdBranch: string | undefined,
  options: CopyGitOptions,
): Promise<void> {
  const call = { ...options, timeoutMs: T.short, acceptNonZero: true };
  // Уборка — вежливость: наверх уходит ПЕРВАЯ причина, а не сбой уборки.
  if (dir) await dropAddedWorktree(repo, dir, options, T.short);
  // Снятие ветки — тоже без хуков проекта (reference-transaction): это уборка ядра, не его commit/push.
  if (createdBranch)
    await withNoHooks((hooks) => git(repo, [...hooks, 'branch', '-D', createdBranch], call)).catch(
      () => undefined,
    );
}

/**
 * Своя недовыложенная копия (ядро начало `worktree add` и упало посреди выкладки): git оставил
 * дерево запертым `initializing`, такое не снимают ни `remove --force`, ни `prune`, а новый add
 * на том же месте падает «missing but locked». Замок снимается, дерево — двойным `-f`, остаток
 * каталога — с чтением назад, и «снято» говорится только когда git его больше не перечисляет.
 * Чужое сюда не попадает: принадлежность решает вызывающий по журналу задачи.
 */
export async function dropUnfinishedCopy(
  repo: string,
  dir: string,
  options: CopyGitOptions = {},
): Promise<{ dropped: true } | { failed: string }> {
  const call = { ...options, timeoutMs: T.short, acceptNonZero: true };
  try {
    await git(repo, ['worktree', 'unlock', dir], call);
    await git(repo, ['worktree', 'remove', '-f', '-f', dir], call);
  } catch (error) {
    return { failed: reasonOf(error) };
  }
  const swept = removeVerified(longForm(dir));
  if (!swept.removed) return { failed: `dir not removed: ${swept.reason}` };
  try {
    await git(repo, ['worktree', 'prune'], call);
  } catch (error) {
    return { failed: reasonOf(error) };
  }
  const listed = await worktreeListed(repo, dir, options.os);
  if (!('value' in listed))
    return { failed: `worktree read-back: ${'unknown' in listed ? listed.unknown : 'absent'}` };
  return listed.value ? { failed: `${dir} still listed by git` } : { dropped: true };
}

/**
 * `complete` — рабочее дерево выложено целиком; `initializing` — git начал выкладку и не закончил
 * (замок `initializing` он снимает только после полной выкладки, или `.git` ведёт в никуда);
 * `empty` — пустой каталог; `foreign` — каталог с содержимым, но не рабочее дерево (не наше —
 * удалять его ядро не вправе). Чьё `initializing`/`complete` — по диску не видно (человеческое
 * дерево с пропавшим основным репозиторием тоже «ведёт в никуда»): это решает журнал задачи.
 */
export type CopyState = 'complete' | 'initializing' | 'empty' | 'foreign';

/** Состояние копии по диску, без git (читатель сверки `copy.exists` и повтор `copy-create`). */
export function copyState(dir: string): Fact<CopyState> {
  // Отказ чтения (EACCES, EBUSY, мусорный путь) — неизвестность (P44), а не исключение наружу.
  try {
    return copyStateOf(longForm(dir, currentOs()));
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

function copyStateOf(root: string): Fact<CopyState> {
  const stats = statSync(root, { throwIfNoEntry: false });
  if (!stats) return { absent: true };
  if (!stats.isDirectory()) return { value: 'foreign' };
  const dotGit = statSync(join(root, '.git'), { throwIfNoEntry: false });
  if (!dotGit) return { value: readdirSync(root).length === 0 ? 'empty' : 'foreign' };
  if (!dotGit.isFile()) return { value: 'foreign' }; // свой репозиторий (.git каталогом), не копия
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(root, '.git'), 'utf8'))?.[1];
  if (!pointer) return { value: 'initializing' };
  const gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
  if (!statSync(join(gitDir, 'HEAD'), { throwIfNoEntry: false })) return { value: 'initializing' };
  const lock = statSync(join(gitDir, 'locked'), { throwIfNoEntry: false });
  if (lock && /initializing/.test(readFileSync(join(gitDir, 'locked'), 'utf8')))
    return { value: 'initializing' };
  return { value: 'complete' };
}

/**
 * Длинные пути самому репозиторию, а не только своим вызовам: в копии дальше работает агент, и
 * его `git status` без ключа не видит файлы длиннее 260 знаков — показывает их УДАЛЁННЫМИ, а
 * `git add -A` записал бы потерю. Читается и пишется `--local`: свои вызовы ядро запускает с
 * `-c core.longpaths=true` (`gitBaseArgs`), и обычный `--get` вернул бы ключ запуска. Конфиг
 * общий у всех копий репозитория — одной записи хватает. Ответ — ключ, прочитанный назад.
 */
export async function ensureLongPaths(
  repo: string,
  options: CopyGitOptions = {},
): Promise<Fact<'on' | 'not-needed'>> {
  const os = options.os ?? currentOs();
  if (os !== 'win32') return { value: 'not-needed' };
  const call = { ...options, timeoutMs: T.short, acceptNonZero: true };
  try {
    const read = async () =>
      (await git(repo, ['config', '--local', '--get', 'core.longpaths'], call)).stdout.trim();
    if ((await read()) === 'true') return { value: 'on' };
    await git(repo, ['config', '--local', 'core.longpaths', 'true'], {
      ...call,
      acceptNonZero: false,
    });
    return (await read()) === 'true'
      ? { value: 'on' }
      : { unknown: 'core.longpaths not read back as true' };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

/** Четыре списка локального слоя основной копии (сырые выводы `-z`). */
export interface LocalLayerLists {
  flagged: string;
  ignored: string;
  others: string;
  modified: string;
}

export async function localLayerLists(
  main: string,
  options: CopyGitOptions = {},
): Promise<Fact<LocalLayerLists>> {
  const call = { ...options, timeoutMs: T.long };
  try {
    const [flagged, ignored, others, modified] = await Promise.all([
      git(main, ['ls-files', '-v', '-z'], call),
      git(
        main,
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
        call,
      ),
      git(main, ['ls-files', '--others', '--exclude-standard', '-z'], call),
      // Репозиторий без коммитов: HEAD нет, местных правок тоже — пустой список, не отказ.
      git(main, ['diff', '--name-only', '-z', 'HEAD', '--'], { ...call, acceptNonZero: true }),
    ]);
    return {
      value: {
        flagged: flagged.stdout,
        ignored: ignored.stdout,
        others: others.stdout,
        modified: modified.code === 0 ? modified.stdout : '',
      },
    };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

/** Флаги в копии пачками по 50: аргументы не безразмерные. Ответ — пути, где флаг не встал. */
export async function setIndexFlags(
  copy: string,
  flagged: readonly { path: string; flag: 'skip-worktree' | 'assume-unchanged' }[],
  options: CopyGitOptions = {},
): Promise<string[]> {
  const failed: string[] = [];
  for (const flag of ['skip-worktree', 'assume-unchanged'] as const) {
    const paths = flagged.filter((e) => e.flag === flag).map((e) => e.path);
    for (let i = 0; i < paths.length; i += 50) {
      const chunk = paths.slice(i, i + 50);
      try {
        await git(copy, ['update-index', `--${flag}`, '--', ...chunk], {
          ...options,
          timeoutMs: T.short,
        });
      } catch {
        failed.push(...chunk);
      }
    }
  }
  return failed;
}

export interface DirtyPath {
  path: string;
  tracked: boolean;
}

/** `git status --porcelain -z`: два знака статуса, пробел, путь; `??` — неотслеживаемый. */
export function parseStatusZ(stdout: string): DirtyPath[] {
  const out: DirtyPath[] = [];
  const records = stdout.split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const entry = records[i] as string;
    if (entry.length < 4) continue;
    out.push({ path: entry.slice(3), tracked: !entry.startsWith('??') });
    // Переименование несёт второй путь (откуда) отдельной записью — её пропускаем.
    if (entry[0] === 'R' || entry[0] === 'C') i += 1;
  }
  return out;
}

export async function dirtyPaths(
  dir: string,
  pathspecs: readonly string[] = [],
  options: CopyGitOptions = {},
): Promise<Fact<DirtyPath[]>> {
  try {
    const args = ['status', '--porcelain', '-z', '-uall'];
    if (pathspecs.length > 0) args.push('--', ...pathspecs);
    const out = await git(dir, args, { ...options, timeoutMs: T.short });
    return { value: parseStatusZ(out.stdout) };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

/**
 * Вернуть отслеживаемые пути к версии индекса, новые — убрать (с чтением назад). Ответ — что
 * откатилось; не откатилось — `unknown` с причиной, а не тихий успех.
 */
export async function revertPaths(
  dir: string,
  churn: readonly DirtyPath[],
  options: CopyGitOptions = {},
): Promise<Fact<string[]>> {
  const tracked = churn.filter((c) => c.tracked).map((c) => c.path);
  try {
    // Откат — уборка ядра, не его commit/push: post-checkout проекта на нём не идёт (04:133).
    if (tracked.length > 0)
      await withNoHooks((hooks) =>
        git(dir, [...hooks, 'checkout', '--', ...tracked], { ...options, timeoutMs: T.short }),
      );
  } catch (error) {
    return { unknown: `checkout: ${reasonOf(error)}` };
  }
  for (const item of churn.filter((c) => !c.tracked)) {
    const removed = removeVerified(longForm(join(dir, item.path)));
    if (!removed.removed) return { unknown: `remove ${item.path}: ${removed.reason}` };
  }
  return { value: churn.map((c) => c.path) };
}

/** Основная копия репозитория (первая запись `worktree list`). */
export async function mainWorktree(repo: string, os: OsKind = currentOs()): Promise<Fact<string>> {
  const list = await listWorktrees(repo, os);
  if (!('value' in list)) return list;
  const main = list.value[0];
  return main ? { value: main.path } : { unknown: 'git worktree list: empty' };
}

/** Копия значится в списке рабочих деревьев репозитория. */
export async function worktreeListed(
  repo: string,
  dir: string,
  os: OsKind = currentOs(),
): Promise<Fact<boolean>> {
  const list = await listWorktrees(repo, os);
  if (!('value' in list)) return list;
  return { value: list.value.some((t) => samePath(t.path, dir, os)) };
}

/** Имена основной ветки, если удалённый не назвал свою (`<remote>/HEAD` не заведён). */
export const MAIN_BRANCH_NAMES: readonly string[] = ['main', 'master'];

/**
 * От чего отводить ветку единицы (перенесено из панели, `default-base.ts`): основная ветка
 * проекта, а не то, что человек выгрузил в основной копии сейчас — отвод «от HEAD» уносил в ветку
 * и в MR чужие коммиты. Порядок: на что указывает `<remote>/HEAD`, иначе `<remote>/main|master`;
 * удалённого нет — локальная `main`/`master`; ничего — `absent`. Без `fetch`: ядро закрепляет базу
 * при создании задачи, а свежесть удалённой ветки — забота дороги публикации (`ls-remote`, 04:105).
 */
export async function defaultBaseOf(
  repo: string,
  options: CopyGitOptions = {},
): Promise<Fact<string>> {
  const call = { ...options, timeoutMs: T.short, acceptNonZero: true };
  try {
    const read = async (args: string[]): Promise<string> => {
      const out = await git(repo, args, call);
      return out.code === 0 ? out.stdout.trim() : '';
    };
    const exists = async (ref: string): Promise<boolean> =>
      Boolean(await read(['rev-parse', '--verify', '--quiet', ref]));
    const remotes = (await read(['remote']))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (remote) {
      const head = await read([
        'symbolic-ref',
        '--quiet',
        '--short',
        `refs/remotes/${remote}/HEAD`,
      ]);
      const pointed = head.startsWith(`${remote}/`) ? [head.slice(remote.length + 1)] : [];
      for (const name of [...pointed, ...MAIN_BRANCH_NAMES]) {
        if (await exists(`refs/remotes/${remote}/${name}`)) return { value: `${remote}/${name}` };
      }
    }
    for (const name of MAIN_BRANCH_NAMES) {
      if (await exists(`refs/heads/${name}`)) return { value: name };
    }
    return { absent: true };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}
