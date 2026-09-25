import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProjectGitInfo } from '@agentdeck/contracts';
import { git, gitSync, GitError } from './exec.ts';
import {
  parseBranches,
  parseNumstat,
  parseRemoteBranches,
  parseStatus,
  pickRemote,
} from './parse.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Чтение состояния репозитория проекта.
 *
 * ПОЯВЛЯЕТСЯ ТОЛЬКО ПРИ `.git` в каталоге проекта. Проверяем именно вхождение
 * `.git`, а не запуском git: в рабочем дереве worktree это ФАЙЛ, а не каталог,
 * поэтому `existsSync` без `isDirectory`. Нет `.git` — `isRepo:false`, и клиент
 * не рисует пульт вовсе (не «пустой git», а отсутствие раздела).
 */

/** В каталоге проекта есть `.git` (каталог или файл рабочего дерева worktree). */
export function isGitRepo(projectDir: string): boolean {
  return Boolean(projectDir.trim()) && existsSync(join(projectDir, '.git'));
}

/**
 * Каталог, из которого делят задачи на группы: верх репозитория, а не каталог,
 * куда агент ушёл `cd`.
 *
 * CLI держит каталог оболочки между вызовами, и последний `cwd` транскрипта —
 * это `…/cp-admin-ui/src`, если агент туда перешёл. Живой прогон 24.09.2026:
 * такой путь уехал в разделение, `isGitRepo` не нашёл в нём `.git`, и восемь
 * групп стартовали в ОДНОМ каталоге без своих копий.
 *
 * Копия (`git worktree`), чей HEAD совпадает с HEAD основной копии, сворачивается
 * в основную: наследовать от неё нечего, а ветки групп должны отходить от той же
 * базы, что и MR. Копия с собственными коммитами остаётся собой — её ветка и есть
 * база работы. Не репозиторий — каталог как есть.
 */
export async function splitRootOf(dir: string): Promise<string> {
  const read = async (cwd: string, args: string[]): Promise<string | undefined> => {
    try {
      return (await git(cwd, args)).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const top = await read(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return dir;
  const root = resolve(top);
  const gitDir = await read(root, ['rev-parse', '--absolute-git-dir']);
  const common = await read(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!gitDir || !common || samePath(gitDir, common) || basename(common) !== '.git') return root;
  const main = dirname(resolve(common));
  const [head, mainHead] = await Promise.all([
    read(root, ['rev-parse', 'HEAD']),
    read(main, ['rev-parse', 'HEAD']),
  ]);
  return head && head === mainHead ? main : root;
}

function samePath(a: string, b: string): boolean {
  const norm = (path: string): string => resolve(path).replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Сделала ли работа в этой копии хоть что-нибудь после момента `since`.
 *
 * Спрашивает конвейер подбора модели перед тем, как завести ревью: проверять
 * пустой дифф значит потратить прогон на потолке ради ответа «замечаний нет».
 *
 * Смотрим обе половины, потому что агент бывает и таким, и таким: незакоммиченные
 * правки (`status`) и коммиты, сделанные после заведения чата (`log --since`).
 * Второе — не роскошь: агент, которому разрешили коммитить, оставляет чистое
 * рабочее дерево, и по одному `status` его работа выглядела бы как её отсутствие.
 *
 * СИНХРОННО и с коротким потолком — вызов идёт из синхронного планировщика
 * завершения прогона. Ответить не удалось (не репозиторий, git не найден,
 * таймаут) — считаем, что работа была: пропустить проверку, за которую уже
 * заплачено понижением, хуже, чем лишний раз её завести.
 */
export function hasWorkSince(projectDir: string, since?: string): boolean {
  const status = gitSync(projectDir, ['status', '--porcelain']);
  if (status === undefined) return true;
  if (status.trim()) return true;
  if (!since) return false;

  // `--since` понимает ISO-время; `-1` останавливает обход на первом же коммите.
  const commits = gitSync(projectDir, ['log', '-1', '--format=%H', `--since=${since}`]);
  return Boolean(commits?.trim());
}

/**
 * Каталог пригоден для операции записи — иначе GitError с причиной. Живёт
 * здесь, а не рядом с операциями: копии (`worktrees.ts`) начинаются с той же
 * проверки, и второй её экземпляр разошёлся бы с этим при первой же правке.
 */
export async function requireRepo(projectDir: string): Promise<ProjectGitInfo> {
  if (!isGitRepo(projectDir)) {
    throw coded(new GitError('В каталоге проекта нет .git — это не репозиторий'), 'git-not-repo');
  }
  const info = await readProjectGit(projectDir);
  if (info.error) throw new GitError(info.error);
  return info;
}

/** Пустое состояние «это не репозиторий» — им же отвечаем и при отсутствии каталога. */
function notARepo(): ProjectGitInfo {
  return {
    isRepo: false,
    detached: false,
    unborn: false,
    branches: [],
    dirtyCount: 0,
    changedFiles: [],
    remoteBranches: [],
  };
}

/**
 * Состояние репозитория проекта. Нет `.git` — `isRepo:false`. Git есть, но
 * ответил ошибкой — `isRepo:true` + `error`: пульт покажет причину и ничего
 * писать не даст (сломанный репозиторий — не повод угадывать).
 */
export async function readProjectGit(projectDir: string): Promise<ProjectGitInfo> {
  if (!isGitRepo(projectDir)) return notARepo();

  try {
    // Пять чтений независимы, поэтому идут разом: последовательно они
    // растянули бы обновление пульта на каждый фокус окна.
    const [statusOut, branchesOut, remotesOut, remoteRefsOut, numstatOut] = await Promise.all([
      git(projectDir, ['status', '--porcelain=v2', '--branch', '-z']),
      git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      git(projectDir, ['remote']),
      git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
      // Строки правок. В репозитории без коммитов сравнивать не с чем, и git
      // отвечает ошибкой — это не поломка состояния, поэтому отказ гасим здесь
      // и остаёмся без чисел, а не без всего пульта.
      git(projectDir, ['diff', '--numstat', 'HEAD']).catch(() => ''),
    ]);
    const status = parseStatus(statusOut);
    const remote = pickRemote(remotesOut);
    const lines = parseNumstat(numstatOut);
    return {
      isRepo: true,
      detached: status.detached,
      unborn: status.unborn,
      branches: parseBranches(branchesOut),
      dirtyCount: status.dirtyCount,
      changedFiles: status.changedFiles,
      remoteBranches: parseRemoteBranches(remoteRefsOut, remote),
      ...(status.changedFilesTruncated ? { changedFilesTruncated: true } : {}),
      ...(lines ?? {}),
      ...(remote ? { remote } : {}),
      ...(status.ahead === undefined ? {} : { ahead: status.ahead }),
      ...(status.behind === undefined ? {} : { behind: status.behind }),
      ...(status.branch ? { branch: status.branch } : {}),
    };
  } catch (error) {
    return {
      ...notARepo(),
      isRepo: true,
      error: error instanceof GitError ? error.message : String(error),
    };
  }
}

/**
 * Какие файлы задела ветка относительно базы — коммитами и незакоммиченным.
 *
 * Спрашивают пересечения веток разделения (Т6): по одному вызову на группу, и
 * ответ у всех обязан быть в одних координатах — пути от корня репозитория,
 * слэшами вперёд. Отсюда два запроса, а не один.
 *
 * `<база>...<ветка>` (три точки) — намеренно: сравнивать надо с ТОЧКОЙ
 * РАСХОЖДЕНИЯ, а не с нынешней базой. Иначе всё, что приехало в базу после
 * заведения копии, посчиталось бы правками группы, и на живом проекте
 * пересечением оказался бы каждый второй файл.
 *
 * Незакоммиченное читается в каталоге копии: агент, которому не разрешали
 * коммитить, всю работу держит именно там, и без второго запроса его ветка
 * выглядела бы пустой. `-uall` обязателен — без него новый каталог схлопывается
 * до имени папки и не совпадает ни с одним путём соседа.
 */
export async function readBranchFiles(input: {
  /** Основная копия: в ней живут обе ветки и их общая история. */
  mainDir: string;
  /** Каталог копии группы — за незакоммиченным. */
  worktreeDir: string;
  base: string;
  branch: string;
}): Promise<string[]> {
  const [committed, dirty] = await Promise.all([
    git(input.mainDir, ['diff', '--name-only', '-z', `${input.base}...${input.branch}`]),
    // Копия могла не пережить перезапуск (её снесли руками) — тогда о ветке
    // известно то, что в истории, и это лучше отказа целиком.
    isGitRepo(input.worktreeDir)
      ? git(input.worktreeDir, ['status', '--porcelain=v1', '-z', '-uall']).catch(() => '')
      : Promise.resolve(''),
  ]);

  const files = new Set<string>();
  for (const path of committed.split('\0')) {
    const value = path.trim();
    if (value) files.add(value);
  }
  for (const path of parseDirtyPaths(dirty)) files.add(path);
  return [...files];
}

/**
 * Что сейчас на самом деле стоит в копии группы — коммит её HEAD.
 *
 * Имя ветки в записи плана — то, что панель ЗАКАЗАЛА, а не то, на чём работа:
 * агент группы вправе завести свою ветку (живой прогон 25.09.2026 — план
 * хранил имя, обрезанное до 100 знаков, агент завёл полное), и сверка по
 * заказанному имени падала `fatal: ambiguous argument`. Копии нет или она не
 * читается — `undefined`, и сверка остаётся при имени из записи.
 */
export async function readWorktreeHead(worktreeDir: string): Promise<string | undefined> {
  if (!isGitRepo(worktreeDir)) return undefined;
  try {
    return (await git(worktreeDir, ['rev-parse', 'HEAD'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Что основная ветка задела С ТОЧКИ РАСХОЖДЕНИЯ с веткой группы (находка 61):
 * `<ветка>...<основная>` — ровно то, что приехало в основную после того, как
 * группа от неё отошла (или после её последнего rebase). Сеть не трогаем:
 * основная — в том виде, в каком её знают ссылки (`readMergeTarget`).
 */
export async function readTargetMoved(input: {
  mainDir: string;
  target: string;
  branch: string;
}): Promise<string[]> {
  const out = await git(input.mainDir, [
    'diff',
    '--name-only',
    '-z',
    `${input.branch}...${input.target}`,
  ]);
  return out
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean);
}

/**
 * Пути из `status --porcelain=v1 -z -uall`. Запись — `XY<пробел><путь>\0`, а у
 * переименования следом отдельным полем идёт ПРЕЖНИЙ путь: считаем оба, потому
 * что задеты оба — сосед, работающий со старым именем, конфликтует именно с ним.
 */
export function parseDirtyPaths(stdout: string): string[] {
  const entries = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3).trim();
    if (path) paths.push(path);
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = entries[index + 1]?.trim();
      index += 1;
      if (from) paths.push(from);
    }
  }
  return paths;
}

/**
 * Ветка, в которую всё это будут сливать, — текущая ветка ОСНОВНОЙ копии.
 * Отсоединённая голова и репозиторий без коммитов ответа не дают: сравнивать
 * не с чем, и пересечения честно скажут, что ветку прочитать не удалось.
 */
export async function readCurrentBranch(projectDir: string): Promise<string | undefined> {
  const out = await git(projectDir, ['branch', '--show-current']).catch(() => '');
  return out.trim() || undefined;
}

/**
 * База, от которой считать правки веток разделения: ветка основной копии — но в
 * том виде, в каком её знает удалённый, если локальная от него отстала.
 *
 * Локальный `main` основной копии живёт своей жизнью: его не подтягивают
 * неделями, а группы работают от свежего `origin/main` (агент сам делает
 * `fetch`/`rebase` по правилам проекта). Три точки против отставшей ветки
 * расходятся с веткой группы в СТАРОЙ точке, и всё, что приехало в `main` с тех
 * пор, считалось правками группы: живой прогон 24.09.2026 — 481 файл вместо 232,
 * пересечения по чужим Go-сервисам и helm (находка 52).
 *
 * Отслеживаемая ветка берётся, только если локальная — её предок (отстала, но не
 * разошлась): у локальных коммитов поверх удалённого группы отведены именно от
 * них, и сравнивать с удалённым значило бы записать эти коммиты в правки групп.
 * Отслеживаемой нет — ветка того же имени у основного удалённого; нет и её —
 * локальная ветка, как раньше. Сеть не трогаем: только то, что уже в ссылках.
 */
export async function readMergeTarget(projectDir: string): Promise<string | undefined> {
  const local = await readCurrentBranch(projectDir);
  if (!local) return undefined;
  const read = async (args: string[]): Promise<string> =>
    (await git(projectDir, args).catch(() => '')).trim();
  let remote = await read([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    `${local}@{upstream}`,
  ]);
  if (!remote) {
    const name = pickRemote(await read(['remote']));
    const candidate = name ? `${name}/${local}` : '';
    if (
      candidate &&
      (await read(['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`]))
    ) {
      remote = candidate;
    }
  }
  if (!remote) return local;
  const behind = await git(projectDir, ['merge-base', '--is-ancestor', local, remote]).then(
    () => true,
    () => false,
  );
  return behind ? remote : local;
}
