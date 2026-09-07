import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectGitInfo } from '@agentdeck/contracts';
import { git, gitSync, GitError } from './exec.ts';
import {
  parseBranches,
  parseNumstat,
  parseRemoteBranches,
  parseStatus,
  pickRemote,
} from './parse.ts';

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
    throw new GitError('В каталоге проекта нет .git — это не репозиторий');
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
