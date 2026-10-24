import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorktree, type GroupAutoApprove } from './group-permissions.ts';

/**
 * `withWorktree` на настоящем репозитории (реплей 23.10): прогон в подпроекте
 * копии судит копию целиком, а у отсоединённой HEAD своя ветка — из записи
 * разделения. Ветка по git, если она есть, всегда сильнее записи.
 */
describe('withWorktree — корень копии и своя ветка по git', () => {
  const repo = mkdtempSync(join(tmpdir(), 'with-worktree-'));
  const sub = join(repo, 'inst-config', 'src');
  const run = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repo,
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
    rows: {} as GroupAutoApprove['rows'],
    allowEdits: true,
    parentChatId: 'parent',
    groupIndex: 0,
    ...(branch ? { branch } : {}),
  });
  const push = { toolName: 'Bash', input: { command: 'git push origin HEAD' } };

  beforeAll(() => {
    run('init', '-q', '-b', 'feature/x');
    run('commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(sub, { recursive: true });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('прогон в подпроекте — копия и git у корня, ветка по git', async () => {
    const placed = await withWorktree(group('fix/record'), sub, push);
    expect(placed.worktree).toBe(repo);
    expect(placed.ownBranch).toBe('feature/x');
  });

  it('HEAD отсоединена — своя ветка из записи разделения; защищённая запись — своей нет', async () => {
    run('checkout', '-q', '--detach');
    try {
      expect((await withWorktree(group('fix/record'), repo, push)).ownBranch).toBe('fix/record');
      expect((await withWorktree(group('main'), repo, push)).ownBranch).toBeUndefined();
      expect((await withWorktree(group(), repo, push)).ownBranch).toBeUndefined();
    } finally {
      run('checkout', '-q', 'feature/x');
    }
  });

  it('псевдоним снимка оболочки (раунд 10): `gp` = `git push` — ветку читаем, псевдонимы едут в суд', async () => {
    const gp = { toolName: 'Bash', input: { command: 'gp origin HEAD' } };
    const aliases = { gp: 'git push' };
    const placed = await withWorktree(group(), repo, gp, undefined, async () => aliases);
    expect(placed.aliases).toEqual(aliases);
    expect(placed.ownBranch).toBe('feature/x');
    // Без псевдонима `gp` — неизвестное имя: ветка не нужна.
    const bare = await withWorktree(group(), repo, gp, undefined, async () => undefined);
    expect(bare.aliases).toBeUndefined();
    expect(bare.ownBranch).toBeUndefined();
  });

  it('PowerShell (раунд 10): снимок не читается, команда судится тем же разбором — ветку читаем', async () => {
    let asked = 0;
    const ps = { toolName: 'PowerShell', input: { command: 'git push origin HEAD' } };
    const placed = await withWorktree(group(), repo, ps, undefined, async () => {
      asked += 1;
      return { git: 'rm -rf ~' };
    });
    expect(asked).toBe(0);
    expect(placed.aliases).toBeUndefined();
    expect(placed.ownBranch).toBe('feature/x');
  });

  it('копия на основной — запись разделения ветку не подменяет', async () => {
    run('checkout', '-q', '-b', 'main');
    try {
      expect((await withWorktree(group('fix/record'), sub, push)).ownBranch).toBeUndefined();
    } finally {
      run('checkout', '-q', 'feature/x');
    }
  });
});
