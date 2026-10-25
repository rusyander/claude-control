import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { movesHistory } from './main-sync.ts';
import { syncUnderway } from './sync-underway.ts';

/**
 * Идущий догон целевой ветки (журнал 24.10, D33) на настоящем git: перебазирование
 * на `origin/main` с конфликтом — догон, перебазирование своей истории — нет.
 * Сервера у репозитория нет: целевая ветка — `origin/main` копии.
 */
const dirs: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function commit(dir: string, text: string, message: string): void {
  writeFileSync(join(dir, 'a.txt'), text);
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-qm', message);
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-underway-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'feat/x');
  git(dir, 'config', 'core.autocrlf', 'false');
  commit(dir, 'base\n', 'base');
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('syncUnderway: догон целевой уже идёт', () => {
  it('перебазирование на origin/main с конфликтом — идёт; после --abort — нет', async () => {
    const dir = repo();
    git(dir, 'checkout', '-q', '-b', 'mainline');
    commit(dir, 'theirs\n', 'main side');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', 'feat/x');
    commit(dir, 'ours\n', 'own side');
    expect(await syncUnderway(dir, undefined)).toBe(false);
    expect(() => git(dir, 'rebase', 'origin/main')).toThrow();
    expect(await syncUnderway(dir, undefined)).toBe(true);
    git(dir, 'rebase', '--abort');
    expect(await syncUnderway(dir, undefined)).toBe(false);
  });

  it('перебазирование своей истории (`--onto` своего коммита) — не догон', async () => {
    const dir = repo();
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    commit(dir, 'one\n', 'c1');
    commit(dir, 'two\n', 'c2');
    commit(dir, 'three\n', 'c3');
    // Выкинуть c2: c3 правит строку, которой без c2 нет, — конфликт.
    expect(() => git(dir, 'rebase', '--onto', 'HEAD~2', 'HEAD~1')).toThrow();
    expect(await syncUnderway(dir, undefined)).toBe(false);
  });

  it('слияние origin/main с конфликтом — идёт', async () => {
    const dir = repo();
    git(dir, 'checkout', '-q', '-b', 'mainline');
    commit(dir, 'theirs\n', 'main side');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', 'feat/x');
    commit(dir, 'ours\n', 'own side');
    expect(() => git(dir, 'merge', '-q', 'origin/main')).toThrow();
    expect(await syncUnderway(dir, undefined)).toBe(true);
  });
});

describe('movesHistory: что посреди догона сверяется заново', () => {
  it.each([
    ['git merge origin/main', true],
    ['git rebase origin/main', true],
    ['git reset --hard origin/main', true],
    ['git checkout -B feat/x origin/main', true],
    ["bash -c 'git rebase origin/main'", true],
    ['git fetch origin main:feat/x', true],
    ['git show origin/main:a.txt > a.txt', false],
    ['git checkout origin/main -- a.txt', false],
    ['git diff HEAD origin/main -- a.txt | git apply', false],
  ])('%s → %s', (command, expected) => {
    expect(movesHistory(command)).toBe(expected);
  });
});
