import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBranchWorktree, copyState, revertPaths } from './copy-git.ts';
import type { GitRunner } from './git/git.types.ts';
import { runTool } from './run-tool.ts';

/**
 * Состояние копии по диску (читатель сверки `copy.exists` и повтор `copy-create`): указатель `.git`
 * разбирается целиком — путь с «s» на конце и пробелами вокруг не обрезается, готовая копия не
 * выглядит недовыложенной.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-copy-state-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function worktree(name: string, gitDirName: string, pointerLine?: string): string {
  const gitDir = join(root, name, 'main', '.git', 'worktrees', gitDirName);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/task\n');
  const copy = join(root, name, 'copy');
  mkdirSync(copy);
  writeFileSync(join(copy, '.git'), pointerLine ?? `gitdir: ${gitDir}\n`);
  return copy;
}

/** Репозиторий с одним коммитом и post-checkout, который оставляет метку, если git его исполнил. */
function hookedRepo(name: string): {
  repo: string;
  marker: string;
  git: (...a: string[]) => string;
} {
  const repo = join(root, name);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'v1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  const marker = join(root, `${name}-hook-ran`);
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(
    join(repo, '.git', 'hooks', 'post-checkout'),
    `#!/bin/sh\necho ran >> "${marker.replaceAll('\\', '/')}"\n`,
    { mode: 0o755 },
  );
  return { repo, marker, git };
}

describe('platform/copy-git addBranchWorktree', () => {
  it('a branch copy runs no project hook; reverting a rewritten lock file runs none either', async () => {
    const { repo, marker } = hookedRepo('hooked');
    const dir = join(root, 'hooked-copy');
    expect(await addBranchWorktree(repo, dir, 'task-h', 'HEAD')).toMatchObject({ created: dir });
    expect(existsSync(marker)).toBe(false);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'rewritten\n');
    const reverted = await revertPaths(dir, [{ path: 'pnpm-lock.yaml', tracked: true }]);
    expect(reverted).toEqual({ value: ['pnpm-lock.yaml'] });
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('v1\n');
    expect(existsSync(marker)).toBe(false);
  });

  it('worktree add runs under the C locale: the «initializing» lock is git’s untranslated word', async () => {
    const { repo } = hookedRepo('locale');
    const envs: NodeJS.ProcessEnv[] = [];
    const run: GitRunner = (file, args, options) => {
      if (args.includes('worktree') && args.includes('add')) envs.push(options?.env ?? {});
      return runTool(file, args, options);
    };
    const dir = join(root, 'locale-copy');
    const added = await addBranchWorktree(repo, dir, 'task-l', 'HEAD', {
      run,
      env: { ...process.env, LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
    });
    expect(added).toMatchObject({ created: dir });
    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({ LC_ALL: 'C', LANGUAGE: 'C' });
  });

  it('git killed mid checkout leaves its «initializing» lock: the undo still removes the copy and the new branch', async () => {
    const { repo, git } = hookedRepo('killed');
    const dir = join(root, 'killed-copy');
    // Внешняя граница — процесс git: выкладка прошла, замок остался, ядро видит таймаут.
    const run: GitRunner = async (file, args, options) => {
      if (!(args.includes('worktree') && args.includes('add'))) return runTool(file, args, options);
      await runTool(file, args, options);
      writeFileSync(join(repo, '.git', 'worktrees', 'killed-copy', 'locked'), 'initializing\n');
      return { ok: false, reason: 'timed out after 300000 ms', timedOut: true };
    };
    const got = await addBranchWorktree(repo, dir, 'task-k', 'HEAD', { run });
    expect(got).toMatchObject({ failed: expect.stringContaining('timed out') });
    expect(existsSync(dir)).toBe(false);
    expect(git('worktree', 'list')).not.toContain('killed-copy');
    expect(git('branch', '--list', 'task-k')).toBe('');
  });

  it('a neighbour taking the dir between the occupancy check and the add keeps its copy', async () => {
    const { repo, git } = hookedRepo('race');
    const dir = join(root, 'race-copy');
    let first = true;
    // Сосед (другая ветка на то же имя каталога) выкладывает копию сразу после нашей проверки.
    const run: GitRunner = async (file, args, options) => {
      if (first) {
        first = false;
        git('worktree', 'add', '-q', '-b', 'feat-a', dir);
        writeFileSync(join(dir, 'work.txt'), 'neighbour work');
      }
      return runTool(file, args, options);
    };
    const got = await addBranchWorktree(repo, dir, 'feat/a', 'HEAD', { run });
    expect('failed' in got).toBe(true);
    expect(readFileSync(join(dir, 'work.txt'), 'utf8')).toBe('neighbour work');
    expect(git('worktree', 'list')).toContain('race-copy');
    expect(git('branch', '--list', 'feat/a')).toBe('');
  });

  it('a failed second add at the same dir leaves the first copy, its work and its branch', async () => {
    const repo = join(root, 'branch-repo');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    execFileSync('git', ['init', '-q', repo]);
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    const dir = join(root, 'branch-copy');
    const first = await addBranchWorktree(repo, dir, 'task-a', 'HEAD');
    expect(first).toMatchObject({ created: dir });
    writeFileSync(join(dir, 'work.txt'), 'uncommitted');
    const second = await addBranchWorktree(repo, dir, 'task-b', 'HEAD');
    expect('failed' in second).toBe(true);
    expect(readFileSync(join(dir, 'work.txt'), 'utf8')).toBe('uncommitted');
    expect(git('worktree', 'list')).toContain('branch-copy');
    expect(git('branch', '--list', 'task-a')).toContain('task-a');
    expect(git('branch', '--list', 'task-b')).toBe('');
  });
});

describe('platform/copy-git copyState', () => {
  it('a finished copy whose git dir ends in «s» is complete, the pointer is read whole', () => {
    expect(copyState(worktree('tail-s', 'tests'))).toEqual({ value: 'complete' });
  });

  it('spaces around the pointer and a relative pointer are resolved, not trimmed into another path', () => {
    const gitDir = join(root, 'rel', 'main', '.git', 'worktrees', 'docs');
    const copy = worktree('rel', 'docs', 'gitdir:   ../main/.git/worktrees/docs   \n');
    expect(copyState(copy)).toEqual({ value: 'complete' });
    writeFileSync(join(gitDir, 'locked'), 'initializing');
    expect(copyState(copy)).toEqual({ value: 'initializing' });
  });

  it('no HEAD behind the pointer or no pointer at all is initializing; empty, foreign and absent dirs are named', () => {
    const copy = worktree('no-head', 'ops');
    rmSync(join(root, 'no-head', 'main', '.git', 'worktrees', 'ops', 'HEAD'));
    expect(copyState(copy)).toEqual({ value: 'initializing' });
    expect(copyState(worktree('no-pointer', 'x', 'garbage\n'))).toEqual({ value: 'initializing' });

    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(copyState(empty)).toEqual({ value: 'empty' });
    writeFileSync(join(empty, 'file.txt'), 'x');
    expect(copyState(empty)).toEqual({ value: 'foreign' });
    mkdirSync(join(root, 'own-repo', '.git'), { recursive: true });
    expect(copyState(join(root, 'own-repo'))).toEqual({ value: 'foreign' });
    expect(copyState(join(root, 'missing'))).toEqual({ absent: true });
  });

  it('a path the file system refuses to read is unknown, not a throw', () => {
    const state = copyState(join(root, 'bad\0name'));
    expect(state).toMatchObject({ unknown: expect.any(String) });
  });
});
