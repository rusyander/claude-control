import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { addWorktree, defaultBaseOf } from './project-git.ts';

/**
 * От чего отводится ветка группы разделения. Только на НАСТОЯЩИХ репозиториях:
 * весь вопрос — что ответит git про `origin/HEAD`, удалённые ветки и
 * отслеживание, подделка доказала бы только саму себя.
 *
 * Поломка, ради которой это есть: папка проекта стояла на ветке задачи человека,
 * и ветка группы, отведённая «от HEAD», унесла её коммиты в свой MR.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  run(cwd, 'add', '-A');
  run(cwd, 'commit', '-q', '-m', text);
  return run(cwd, 'rev-parse', 'HEAD');
}

function identity(cwd: string): void {
  run(cwd, 'config', 'user.email', 'test@example.invalid');
  run(cwd, 'config', 'user.name', 'Test');
  run(cwd, 'config', 'commit.gpgsign', 'false');
}

describe.skipIf(!hasGit())('defaultBaseOf: основа ветки группы — основная ветка проекта', () => {
  let root: string;
  let remote: string;
  let dir: string;
  let mainCommit: string;

  beforeEach(() => {
    // Длинный вид пути: git отвечает им, а `os.tmpdir()` в Windows даёт 8.3.
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-base-')));
    remote = join(root, 'remote.git');
    dir = join(root, 'project');
    run(root, 'init', '-q', '--bare', '--initial-branch=main', remote);
    run(root, 'clone', '-q', remote, dir);
    identity(dir);
    mainCommit = commit(dir, 'file.txt', 'основа');
    run(dir, 'push', '-q', '-u', 'origin', 'main');
  });

  afterEach(() => {
    dropTemp(join(dirname(dir), `${basename(dir)}-worktrees`));
    dropTemp(root);
  });

  it('папка проекта на ветке задачи — ветка группы отводится от origin/main, без её коммитов', async () => {
    run(dir, 'checkout', '-q', '-b', 'feat/human-task');
    const foreign = commit(dir, 'human.txt', 'работа человека');

    const base = await defaultBaseOf(dir);
    expect(base).toBe('origin/main');

    const copy = await addWorktree(dir, 'group/one', undefined, base);
    expect(run(copy.path, 'rev-parse', 'HEAD')).toBe(mainCommit);
    // Коммита человека в ветке группы нет.
    expect(() => run(copy.path, 'merge-base', '--is-ancestor', foreign, 'HEAD')).toThrow();
    // И она не отслеживает main: `git push` из копии не целит в основную ветку.
    expect(() => run(copy.path, 'rev-parse', '--abbrev-ref', 'group/one@{upstream}')).toThrow();
  });

  it('удалённая основная ветка ушла вперёд — основа свежая, а не прежний снимок', async () => {
    const other = join(root, 'other');
    run(root, 'clone', '-q', remote, other);
    identity(other);
    const fresh = commit(other, 'more.txt', 'новое на main');
    run(other, 'push', '-q', 'origin', 'main');

    const base = await defaultBaseOf(dir);
    expect(base).toBe('origin/main');
    expect(run(dir, 'rev-parse', 'origin/main')).toBe(fresh);
  });

  it('основную ветку назвал origin/HEAD — берётся она, а не main', async () => {
    run(dir, 'push', '-q', 'origin', 'main:develop');
    run(dir, 'fetch', '-q', 'origin');
    run(dir, 'remote', 'set-head', 'origin', 'develop');

    expect(await defaultBaseOf(dir)).toBe('origin/develop');
  });

  it('удалённого нет — локальная main', async () => {
    run(dir, 'remote', 'remove', 'origin');
    run(dir, 'checkout', '-q', '-b', 'feat/human-task');
    commit(dir, 'human.txt', 'работа человека');

    expect(await defaultBaseOf(dir)).toBe('main');
  });

  it('ни удалённого, ни main/master — ответа нет, копия пойдёт от HEAD', async () => {
    run(dir, 'remote', 'remove', 'origin');
    run(dir, 'branch', '-q', '-m', 'main', 'trunk');

    expect(await defaultBaseOf(dir)).toBeUndefined();
  });
});
