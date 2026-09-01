import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectGitInfo } from '@claude-control/contracts';
import { git, GitError } from './exec.ts';
import { parseBranches, parseRemoteBranches, parseStatus, pickRemote } from './parse.ts';

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
    // Четыре чтения независимы, поэтому идут разом: последовательно они
    // растянули бы обновление пульта на каждый фокус окна.
    const [statusOut, branchesOut, remotesOut, remoteRefsOut] = await Promise.all([
      git(projectDir, ['status', '--porcelain=v2', '--branch', '-z']),
      git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      git(projectDir, ['remote']),
      git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
    ]);
    const status = parseStatus(statusOut);
    const remote = pickRemote(remotesOut);
    return {
      isRepo: true,
      detached: status.detached,
      unborn: status.unborn,
      branches: parseBranches(branchesOut),
      dirtyCount: status.dirtyCount,
      changedFiles: status.changedFiles,
      remoteBranches: parseRemoteBranches(remoteRefsOut, remote),
      ...(status.changedFilesTruncated ? { changedFilesTruncated: true } : {}),
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
