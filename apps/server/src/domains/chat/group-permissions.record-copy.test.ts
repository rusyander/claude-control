import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { recordBranchCopy } from './group-copy-root.ts';
import { canonical } from './group-command/paths.ts';
import { groupDecision, withWorktree, type GroupAutoApprove } from './group-permissions.ts';

/**
 * Своя копия группы, чей прогон записан в основной копии (решение 23.10): своя —
 * копия ветки записи разделения, которую перечисляет ЭТОТ репозиторий
 * (`git worktree list`, живьём). Соседняя копия на другой ветке, основная копия,
 * отсоединённая копия, чужой репозиторий и защищённая или пустая запись — не
 * своя. Всё на настоящем git во временном каталоге.
 */
describe('recordBranchCopy / withWorktree — своя копия по ветке записи', () => {
  // Настоящее имя каталога: короткое имя TEMP на Windows (`RUSYAN~1`) git пишет длинным.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'record-copy-')));
  const main = join(base, 'shop');
  const trees = join(base, 'shop-worktrees');
  const own = join(trees, 'fix-a');
  const sibling = join(trees, 'fix-b');
  const detached = join(trees, 'fix-d');
  const foreign = join(trees, 'foreign');
  const run = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  const group = (branch?: string): GroupAutoApprove => ({
    rows: { ...GROUP_REQUEST_DEFAULTS },
    allowEdits: true,
    parentChatId: 'parent',
    groupIndex: 0,
    tree: { dirty: false },
    ...(branch ? { branch } : {}),
  });
  const bash = (command: string) => ({ toolName: 'Bash', input: { command } });
  /** Решение маршрута прав группы: место по git, каталог оболочки — основная копия. */
  const decide = async (record: string | undefined, command: string): Promise<string> => {
    const placed = await withWorktree(group(record), main, bash(command));
    return groupDecision(
      { ...placed, shellCwd: main },
      { toolName: 'Bash', input: { command }, guardedPatterns: [] },
    );
  };
  const slash = (path: string): string => path.replace(/\\/g, '/');

  beforeAll(() => {
    mkdirSync(main, { recursive: true });
    run(main, 'init', '-q', '-b', 'main');
    run(main, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(main, 'a.txt'), 'one\n');
    run(main, 'add', '-A');
    run(main, 'commit', '-qm', 'init');
    run(main, 'worktree', 'add', '-q', '-b', 'fix/a', own);
    run(main, 'worktree', 'add', '-q', '-b', 'fix/b', sibling);
    run(main, 'worktree', 'add', '-q', '-b', 'fix/d', detached);
    run(detached, 'checkout', '-q', '--detach');
    run(main, 'worktree', 'add', '-q', '-b', 'develop', join(trees, 'develop'));
    mkdirSync(foreign, { recursive: true });
    run(foreign, 'init', '-q', '-b', 'fix/x');
    run(foreign, 'commit', '-q', '--allow-empty', '-m', 'init');
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('основная копия, ветка записи у копии ветки этого репозитория — своя эта копия', async () => {
    const found = await recordBranchCopy(main, 'fix/a');
    expect(found && canonical(found)).toBe(canonical(own));
    const placed = await withWorktree(group('fix/a'), join(main), bash('git push origin HEAD'));
    expect(canonical(placed.worktree ?? '')).toBe(canonical(own));
    expect(placed.ownBranch).toBe('fix/a');
  });

  it('пуш и уборка в своей копии после `cd` из основной — сами', async () => {
    expect(await decide('fix/a', `cd ${slash(own)} && git push -u origin fix/a`)).toBe('auto');
    expect(await decide('fix/a', `cd ${slash(own)} && rm -f zz_probe.test.ts`)).toBe('auto');
  });

  it('нет совпадения — ничего не расширяется', async () => {
    // Соседняя копия на другой ветке, отсоединённая копия, копия чужого
    // репозитория, защищённая и пустая запись, запуск не из основной копии.
    expect(await recordBranchCopy(main, 'fix/c')).toBeUndefined();
    expect(await recordBranchCopy(main, 'fix/d')).toBeUndefined();
    expect(await recordBranchCopy(main, 'fix/x')).toBeUndefined();
    expect(await recordBranchCopy(main, 'main')).toBeUndefined();
    // Копия ветки на защищённой ветке есть, но защищённая запись своей не даёт.
    expect(await recordBranchCopy(main, 'develop')).toBeUndefined();
    expect(await recordBranchCopy(main, undefined)).toBeUndefined();
    expect(await recordBranchCopy(sibling, 'fix/a')).toBeUndefined();
  });

  it('список другого репозитория не в счёт: первой в нём стоит не эта копия', async () => {
    const elsewhere = {
      list: async (): Promise<string> =>
        `worktree ${slash(foreign)}\nHEAD 0\nbranch refs/heads/fix/x\n\n` +
        `worktree ${slash(own)}\nHEAD 0\nbranch refs/heads/fix/a\n`,
    };
    expect(await recordBranchCopy(main, 'fix/a', elsewhere)).toBeUndefined();
    const listed = {
      list: async (): Promise<string> =>
        `worktree ${slash(main)}\nHEAD 0\nbranch refs/heads/main\n\n` +
        `worktree ${slash(own)}\nHEAD 0\nbranch refs/heads/fix/a\n`,
    };
    expect(await recordBranchCopy(main, 'fix/a', listed)).toBe(slash(own));
  });

  it('основная копия своей этим правилом не становится, даже на ветке записи', async () => {
    run(main, 'checkout', '-q', '-b', 'fix/m');
    try {
      expect(await recordBranchCopy(main, 'fix/m')).toBeUndefined();
    } finally {
      run(main, 'checkout', '-q', 'main');
    }
  });

  it('красные: соседняя копия на другой ветке и сама основная копия — человеку', async () => {
    // Соседняя копия группы `fix/a` на ветке `fix/b`.
    expect(await decide('fix/a', `cd ${slash(sibling)} && git push -u origin fix/b`)).toBe('human');
    expect(await decide('fix/a', `cd ${slash(sibling)} && rm -f a.txt`)).toBe('human');
    // Своя копия найдена — основная копия от этого не своя.
    expect(await decide('fix/a', `cd ${slash(main)} && rm -f a.txt`)).toBe('human');
    expect(await decide('fix/a', 'rm -f a.txt')).toBe('human');
    expect(await decide('fix/a', 'git checkout -- .')).toBe('human');
    expect(await decide('fix/a', `cd ${slash(main)} && git push origin HEAD`)).toBe('human');
    // Ветки записи ни у одной копии нет — копией остаётся основная, `cd` в чужую — человеку.
    expect(await decide('fix/c', `cd ${slash(own)} && git push -u origin fix/a`)).toBe('human');
  });
});
