import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitDiscards, guardUncommitted } from './group-tree-state.ts';

/**
 * Сторож затирания на настоящем git (аудит 23.10, A-10…A-16): то, что снимок
 * не удержит, а затирание сотрёт, — не «чистое дерево», а решение человека
 * (`unknown`). Проверяется настоящий `guardUncommitted` с чтением дерева по
 * умолчанию — тем же, что у маршрута прав группы.
 */
const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tree-guard-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'feat/x');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const guard = (dir: string, command: string) => guardUncommitted(dir, command, ['discard']);

describe('guardUncommitted: что снимок не удержит', () => {
  it('A-10: `status.showUntrackedFiles=no` не прячет новые файлы — снимок снимается', async () => {
    const dir = repo();
    git(dir, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(dir, 'new.txt'), 'new\n');
    const result = await guard(dir, 'git clean -fd');
    expect(result).toMatchObject({ tree: { dirty: true } });
    const backup = 'tree' in result && typeof result.tree === 'object' && result.tree.dirty;
    expect(backup).toBe(true);
  });

  it.each([
    ['A-14', 'submodule.recurse'],
    ['A-15', 'core.sparseCheckout'],
  ])('%s: `%s=true` — решает человек', async (_id, key) => {
    const dir = repo();
    git(dir, 'config', key, 'true');
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    expect(await guard(dir, 'git reset --hard')).toEqual({ tree: 'unknown' });
  });

  it('A-16: правка файла с `assume-unchanged` — решает человек', async () => {
    const dir = repo();
    git(dir, 'update-index', '--assume-unchanged', 'a.txt');
    writeFileSync(join(dir, 'a.txt'), 'hidden edit\n');
    expect(await guard(dir, 'git reset --hard')).toEqual({ tree: 'unknown' });
  });

  it('A-12: игнор переписан той же командой перед `clean` — решает человек', async () => {
    const dir = repo();
    expect(await guard(dir, "printf 'x' > .gitignore && git clean -fd")).toEqual({
      tree: 'unknown',
    });
    expect(await guard(dir, "echo '' > .git/info/exclude; git clean -fd")).toEqual({
      tree: 'unknown',
    });
  });

  it('обычная копия: чистая — без снимка, грязная — снимок, решение само', async () => {
    const dir = repo();
    expect(await guard(dir, 'git clean -fd')).toEqual({ tree: { dirty: false } });
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    const result = await guard(dir, 'git reset --hard');
    expect(result).toMatchObject({ tree: { dirty: true } });
    const ref =
      'tree' in result && typeof result.tree === 'object' && result.tree.dirty
        ? result.tree.backup
        : '';
    expect(git(dir, 'show', `${ref}:a.txt`)).toBe('edited');
  });

  /** Копия посреди слияния с конфликтом в `a.txt` (маркеры в файле, индекс неслит). */
  function conflicted(): string {
    const dir = repo();
    git(dir, 'checkout', '-qb', 'other');
    writeFileSync(join(dir, 'a.txt'), 'theirs\n');
    git(dir, 'commit', '-qam', 'theirs');
    git(dir, 'checkout', '-q', 'feat/x');
    writeFileSync(join(dir, 'a.txt'), 'ours\n');
    git(dir, 'commit', '-qam', 'ours');
    expect(() => git(dir, 'merge', '-q', 'other')).toThrow();
    return dir;
  }

  const backupOf = (result: Awaited<ReturnType<typeof guard>>): string =>
    'tree' in result && typeof result.tree === 'object' && result.tree.dirty
      ? result.tree.backup
      : '';

  // Журнал 24.10, D31/D32: снимок на неслитом индексе не выходил, и сторож
  // отказывал самому разрешению конфликта — отказ звал «разреши конфликт».
  it('D31: конфликт слияния — снимок снимается вместе с маркерами, затирание идёт само', async () => {
    const dir = conflicted();
    const result = await guard(dir, 'git checkout -- .');
    expect(result).not.toHaveProperty('deny');
    expect(git(dir, 'show', `${backupOf(result)}:a.txt`)).toContain('<<<<<<<');
    // Снимок ничего не тронул: конфликт на месте.
    expect(git(dir, 'ls-files', '-u')).not.toBe('');
  });

  // D30: `git checkout --ours пути` без `--` судили сменой ветки на грязном
  // дереве — SWITCH_REFUSAL посреди перебазирования, которое разрешила панель.
  it('D30: `checkout --ours|--theirs пути` без `--` — восстановление файлов, не смена ветки', async () => {
    const dir = conflicted();
    const scope = { worktree: dir, cwd: dir, branch: 'feat/x' };
    for (const command of ['git checkout --ours a.txt', 'git checkout --theirs -- a.txt']) {
      const discards = gitDiscards(command, scope);
      expect(`${command} → ${discards.join(',')}`).toBe(`${command} → discard`);
      const result = await guardUncommitted(dir, command, discards);
      expect(result).not.toHaveProperty('deny');
    }
    // `-m` ветку меняет и без стороны конфликта — без `--` это смена ветки.
    expect(gitDiscards('git checkout -m other', scope)).toContain('switch');
  });
});
