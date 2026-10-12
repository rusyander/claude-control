import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import { makeSplitGit, splitTasks, type SplitGit } from './ChatSplit.ts';

/**
 * Сверка копии перед стартом группы (U3). Группа стартует мимо маршрута
 * прогона, где сверка стоит для разговоров человека, — поэтому проверяем оба
 * конца: что недобранная копия не получает прогона, а её причина доходит до
 * карточки, и что настоящий `makeSplitGit` сам дочинивает то, что можно.
 */

const PROPOSAL: TaskSplitProposal = {
  groups: [
    { title: 'Форма входа', branch: 'feature/login', tasks: ['починить валидацию'] },
    { title: 'Шапка', branch: 'feature/header', tasks: ['выровнять'] },
  ],
};

function fakeGit(overrides: Partial<SplitGit> = {}): SplitGit {
  return {
    isRepo: () => true,
    takenBranches: async () => [],
    addWorktree: async (_dir, branch) => ({ path: `/copies/${branch.replace(/\//g, '-')}` }),
    ...overrides,
  };
}

describe('splitTasks: копия, которую не удалось добрать, не стартует', () => {
  it('группа с названной дырой — в отказах с причиной, соседняя стартует', async () => {
    const started: string[] = [];
    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git: fakeGit({
        preflight: async (copy) =>
          copy.endsWith('feature-header') ? 'нет серверов: forge' : undefined,
      }),
      now: () => 1000,
      start: ({ chatId }) => {
        started.push(chatId);
        return true;
      },
    });

    expect(started).toEqual(['new-1000-0']);
    expect(result.chats.map((chat) => chat.branch)).toEqual(['feature/login']);
    expect(result.failures).toEqual([
      {
        index: 1,
        title: 'Шапка',
        branch: 'feature/header',
        message: expect.stringContaining('нет серверов: forge'),
      },
    ]);
  });

  it('собственная ошибка сверки группу не держит', async () => {
    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git: fakeGit({
        preflight: async () => {
          throw new Error('сверка упала');
        },
      }),
      now: () => 1000,
      start: () => true,
    });

    expect(result.failures).toEqual([]);
    expect(result.chats.every((chat) => chat.started)).toBe(true);
  });
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
}

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

describe.skipIf(!hasGit())('makeSplitGit.preflight на настоящем репозитории', () => {
  let dir: string;
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-pre-home-'));
    for (const key of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL'] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.XDG_CONFIG_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
    writeFileSync(join(home, 'gitconfig'), '');
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-pre-')));
    gitIn(dir, 'init', '--initial-branch=main');
    gitIn(dir, 'config', 'user.email', 'test@example.invalid');
    gitIn(dir, 'config', 'user.name', 'Test');
    gitIn(dir, 'config', 'commit.gpgsign', 'false');
    gitIn(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{"design":{}}}\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'init');
    // Локальная правка оригинала под флагом — серверы, которых нет в коммите.
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{"design":{},"forge":{}}}\n');
    gitIn(dir, 'update-index', '--skip-worktree', '.mcp.json');
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, '.mcp.json'), past, past);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    dropTemp(join(dirname(dir), `${basename(dir)}-worktrees`));
    dropTemp(dir);
    dropTemp(home);
  });

  it('откаченный .mcp.json дочинивается молча, группа готова', async () => {
    const git = makeSplitGit();
    const copy = await git.addWorktree(dir, 'feature/pre');
    gitIn(copy.path, 'update-index', '--no-skip-worktree', '.mcp.json');
    gitIn(copy.path, 'checkout', '--', '.mcp.json');

    expect(await git.preflight?.(copy.path)).toBeUndefined();
    expect(readFileSync(join(copy.path, '.mcp.json'), 'utf8')).toContain('"forge"');
  });

  it('недобираемое названо: каталог на месте .mcp.json', async () => {
    const git = makeSplitGit();
    const copy = await git.addWorktree(dir, 'feature/pre-broken');
    rmSync(join(copy.path, '.mcp.json'), { force: true });
    mkdirSync(join(copy.path, '.mcp.json', 'inner'), { recursive: true });

    expect(await git.preflight?.(copy.path)).toContain('.mcp.json');
  });
});
