import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_KEEP, pruneBackups, snapshotUncommitted } from './git-snapshot.ts';

const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Настоящий репозиторий во временном каталоге: один коммит, `.env` игнорируется. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-snapshot-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'feat/x');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'two\n');
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('snapshotUncommitted — снимок перед затиранием (решение владельца 23.10)', () => {
  it('правки, индекс и новые файлы переживают reset --hard и clean -fd, дерево и индекс не тронуты', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'one edited\n');
    writeFileSync(join(dir, 'b.txt'), 'two staged\n');
    git(dir, 'add', 'b.txt');
    writeFileSync(join(dir, 'new.txt'), 'brand new\n');
    writeFileSync(join(dir, '.env'), 'SECRET=1\n');
    const statusBefore = git(dir, 'status', '--porcelain');
    const head = git(dir, 'rev-parse', 'HEAD');

    const snapshot = await snapshotUncommitted(dir, 'git reset --hard');

    expect(snapshot?.ref).toMatch(/^refs\/agentdeck\/backup\/\d{4}-\d\d-\d\dT[\d-]+Z-[0-9a-f]+$/);
    // Снимок ничего не сдвинул: то же состояние, тот же HEAD, тот же индекс.
    expect(git(dir, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'rev-parse', `${snapshot?.ref}^1`)).toBe(head);
    // Игнорируемое в снимок не попадает: его git и не стирает без `-x`.
    expect(() => git(dir, 'cat-file', '-e', `${snapshot?.ref}:.env`)).toThrow();

    git(dir, 'reset', '-q', '--hard');
    git(dir, 'clean', '-qfd');
    expect(existsSync(join(dir, 'new.txt'))).toBe(false);

    git(dir, 'restore', `--source=${snapshot?.ref}`, '--worktree', '--', '.');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one edited\n');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('two staged\n');
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('brand new\n');
    // Второй родитель — то, что было в индексе: `b.txt` там уже правленый.
    expect(git(dir, 'show', `${snapshot?.ref}^2:b.txt`)).toBe('two staged');
    expect(git(dir, 'show', `${snapshot?.ref}^2:a.txt`)).toBe('one');
  });

  it('без HEAD и без своего user.email — снимок всё равно выходит', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-snapshot-empty-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'only.txt'), 'x\n');
    const snapshot = await snapshotUncommitted(dir, 'git clean -fd', new Date());
    expect(snapshot).toBeDefined();
    expect(git(dir, 'show', `${snapshot?.ref}:only.txt`)).toBe('x');
  });

  it('не git — снимка нет, вызывающий откажет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-snapshot-none-'));
    dirs.push(dir);
    await expect(snapshotUncommitted(dir, 'git reset --hard')).resolves.toBeUndefined();
  });

  it('старше двух недель и сверх полусотни — убираются, чужие ссылки целы', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'dirty\n');
    const now = new Date();
    git(dir, 'update-ref', 'refs/agentdeck/other', 'HEAD');
    const old = await snapshotUncommitted(dir, 'x', new Date(now.getTime() - 20 * 86_400_000));
    expect(old).toBeDefined();
    // Следующий снимок сам убирает просроченные.
    const fresh = await snapshotUncommitted(dir, 'y', now);
    expect(git(dir, 'for-each-ref', '--format=%(refname)', 'refs/agentdeck/')).toBe(
      [fresh?.ref, 'refs/agentdeck/other'].sort().join('\n'),
    );
    for (let i = 0; i < BACKUP_KEEP + 2; i += 1) {
      git(dir, 'update-ref', `refs/agentdeck/backup/extra-${String(i).padStart(3, '0')}`, 'HEAD');
    }
    // Сверх полусотни считается по копии: 52 посторонних ссылки без строки
    // `copy:` — своя очередь, из неё уходят 2; снимок копии `fresh` цел.
    const trimmed = await pruneBackups(dir, now);
    expect(trimmed).toHaveLength(2);
    expect(trimmed).not.toContain(fresh?.ref);
  });

  it('A-18: полсотни снимков соседней копии не вытесняют единственный снимок этой', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'dirty\n');
    const now = new Date();
    const mine = await snapshotUncommitted(dir, 'mine', new Date(now.getTime() - 60_000));
    const tree = git(dir, 'write-tree');
    for (let i = 0; i < BACKUP_KEEP + 1; i += 1) {
      const sha = git(dir, 'commit-tree', tree, '-m', `agentdeck: x\n\ncopy: C:/other/copy`);
      git(dir, 'update-ref', `refs/agentdeck/backup/other-${String(i).padStart(3, '0')}`, sha);
    }
    const trimmed = await pruneBackups(dir, now);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]).toMatch(/other-/);
    expect(git(dir, 'for-each-ref', '--format=%(refname)', mine?.ref ?? 'x')).toBe(mine?.ref);
  });
});
