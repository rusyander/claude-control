import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  conflictsWith,
  isMainSyncRequest,
  isSoleSync,
  syncsWithTarget,
  syncTarget,
} from './main-sync.ts';

describe('syncsWithTarget', () => {
  it.each([
    'git rebase origin/main',
    'git -C C:/work/x rebase origin/main',
    'git fetch origin && git rebase origin/main',
    'git pull --rebase origin main',
    'git merge origin/main',
    'git rebase --onto origin/main HEAD~3',
    'git merge FETCH_HEAD',
  ])('догон целевой ветки: %s', (command) => {
    expect(syncsWithTarget(command)).toBe(true);
  });

  it.each([
    'git rebase --continue',
    'git rebase --abort',
    'git rebase -i HEAD~3',
    'git merge-base HEAD origin/main',
    'git pull',
    'git log origin/main..HEAD',
    'git merge feat/other',
  ])('не догон: %s', (command) => {
    expect(syncsWithTarget(command)).toBe(false);
  });

  it('только Bash считается командой догона', () => {
    expect(isMainSyncRequest('Bash', { command: 'git rebase origin/main' })).toBe(true);
    expect(isMainSyncRequest('Edit', { command: 'git rebase origin/main' })).toBe(false);
  });
});

describe('syncTarget', () => {
  it.each([
    ['git rebase origin/main', 'origin/main'],
    ['git fetch && git -C x rebase origin/dev', 'origin/dev'],
    ['git pull --rebase origin main', 'origin/main'],
    ['git rebase --onto origin/main HEAD~2', 'origin/main'],
    ['git merge main', 'main'],
  ])('%s → %s', (command, ref) => {
    expect(syncTarget(command)).toBe(ref);
  });
});

// При конфликте без карточки проходит только голый догон: хвост из других звеньев
// или `-C` в чужой каталог идут обычным разбором.
describe('isSoleSync', () => {
  it.each([
    ['git merge origin/main', true],
    ['git rebase origin/main', true],
    ['git pull origin main', true],
    ['git merge origin/main && git push origin main', false],
    ['git fetch && git rebase origin/main', false],
    ['git -C ../other merge origin/main', false],
    ['git merge --continue', false],
    ['git push', false],
  ])('%s → %s', (command, sole) => {
    expect(isSoleSync(command)).toBe(sole);
  });
});

// Настоящий git во временном репозитории: ровно то, что брокер спросит у копии группы.
describe('conflictsWith', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'main-sync-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  writeFileSync(path.join(dir, 'a.txt'), 'feat\n');
  git('commit', '-qam', 'feat');
  git('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'b.txt'), 'other\n');
  git('add', '.');
  git('commit', '-qm', 'other file');
  git('branch', 'clean');
  writeFileSync(path.join(dir, 'a.txt'), 'main\n');
  git('commit', '-qam', 'same line');
  git('checkout', '-q', 'feat');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('main ушёл вперёд другим файлом — конфликта нет', async () => {
    expect(await conflictsWith(dir, 'clean')).toBe(false);
  });

  it('main правил ту же строку — конфликт', async () => {
    expect(await conflictsWith(dir, 'main')).toBe(true);
  });

  it('несуществующая ссылка — не знаем, а не «нет конфликта»', async () => {
    expect(await conflictsWith(dir, 'origin/nope')).toBeUndefined();
  });
});
