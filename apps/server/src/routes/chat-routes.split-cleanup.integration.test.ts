import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';
import type { SplitPlanRecord } from '../lib/app-store/app-store.types.ts';

/**
 * Уборка копии закрытой группы (Д19) поверх НАСТОЯЩИХ маршрута, конвейера и git.
 * Заглушен только процесс CLI — прогонов здесь нет вовсе. Вопрос теста — что
 * именно исчезает с диска и что остаётся: копия уходит, пустая ветка тоже,
 * ветка со своей работой и ветка MR — нет, а открытую группу не трогают.
 */
describe('POST /api/chat/split/:parent/cleanup', () => {
  let root: string;
  let repo: string;
  let app: FastifyInstance;
  let store: AppStore;

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const hasBranch = (name: string): boolean =>
    git(repo, 'branch', '--list', name).trim().length > 0;

  /** Копия группы на своей ветке; `commit` — с собственной работой поверх main. */
  const copy = (branch: string, commit = false): string => {
    const path = join(root, 'repo-worktrees', branch.replace(/\//g, '-'));
    git(repo, 'worktree', 'add', '-b', branch, path);
    if (commit) {
      writeFileSync(join(path, `${branch.replace(/\//g, '-')}.txt`), 'работа\n', 'utf8');
      git(path, 'add', '.');
      git(path, 'commit', '-m', 'работа группы');
    }
    return path;
  };

  const group = (
    index: number,
    branch: string,
    path: string,
    status: SplitPlanRecord['groups'][number]['status'],
  ): SplitPlanRecord['groups'][number] => ({
    index,
    title: `Группа ${index + 1}`,
    branch,
    after: [],
    status,
    chatId: `child-${index + 1}`,
    path,
  });

  const cleanup = (index: number) =>
    app.inject({
      method: 'POST',
      url: '/api/chat/split/parent-1/cleanup',
      payload: { index },
    });

  let paths: string[];

  beforeEach(async () => {
    // Длинный путь, как его пишет git: короткое имя 8.3 (`RUSYAN~1`) копию не найдёт.
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-split-cleanup-')));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'probe@example.com');
    git(repo, 'config', 'user.name', 'probe');
    writeFileSync(join(repo, 'a.txt'), 'раз\n', 'utf8');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'первый');

    paths = [
      copy('feature/empty'),
      copy('feature/work', true),
      copy('feature/open'),
      copy('feature/mr'),
    ];

    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'parent-1',
      projectPath: repo,
      createdAt: '2026-09-23T00:00:00.000Z',
      order: [0, 1, 2, 3],
      request: {},
      proposal: { groups: [] },
      groups: [
        group(0, 'feature/empty', paths[0]!, 'done'),
        group(1, 'feature/work', paths[1]!, 'done'),
        group(2, 'feature/open', paths[2]!, 'started'),
        group(3, 'feature/mr', paths[3]!, 'done'),
      ],
    });
    store.setChatLink('child-4', {
      parentChatId: 'parent-1',
      createdAt: '2026-09-23T00:00:00.000Z',
      review: { url: 'https://example.com/mr/1', branch: 'feature/mr' },
    });

    const ctx = {
      location: {
        paths: { root, appData: join(root, 'agentdeck'), mcpConfig: join(root, '.claude.json') },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
    } as unknown as ServerContext;
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async () => undefined,
      stop: () => undefined,
    }));
    const conveyor = new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (ids) => store.findSplitPlanByTriage(ids),
        all: () => store.getSplitPlans(),
      },
      launch: async () => ({ chats: [], failures: [] }),
      startTriage: () => ({ chatId: '', started: false, deferred: false }),
      log: () => undefined,
    });
    app = Fastify();
    registerChatSplitRoutes(app, ctx, {
      runs: registry,
      providerChats: new ProviderChatService(),
      session: new ChatSession(registry),
      conveyor,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('пустая ветка уходит вместе с копией', async () => {
    const response = await cleanup(0);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ branch: 'deleted' });
    expect(existsSync(paths[0]!)).toBe(false);
    expect(hasBranch('feature/empty')).toBe(false);
    expect(store.getSplitPlan('parent-1')?.groups[0]?.cleaned?.branch).toBe('deleted');
  });

  it('ветка со своей работой остаётся — копии нет, коммиты целы', async () => {
    const response = await cleanup(1);

    expect(response.json()).toMatchObject({ branch: 'kept' });
    expect(existsSync(paths[1]!)).toBe(false);
    expect(hasBranch('feature/work')).toBe(true);
  });

  it('ветку MR панель не трогает, даже пустую', async () => {
    const response = await cleanup(3);

    expect(response.json()).toMatchObject({ branch: 'mr' });
    expect(existsSync(paths[3]!)).toBe(false);
    expect(hasBranch('feature/mr')).toBe(true);
  });

  it('открытую группу и уже убранную копию не трогают', async () => {
    const open = await cleanup(2);
    expect(open.statusCode).toBe(409);
    expect(open.json()).toMatchObject({ messageCode: 'split-cleanup-nothing' });
    expect(existsSync(paths[2]!)).toBe(true);

    await cleanup(0);
    const again = await cleanup(0);
    expect(again.statusCode).toBe(409);
  });

  it('копию делит незакрытая группа — отказ, копия на месте', async () => {
    const record = store.getSplitPlan('parent-1')!;
    record.groups[2]!.path = paths[0]!;
    store.setSplitPlan(record);

    const response = await cleanup(0);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'split-cleanup-shared' });
    expect(existsSync(paths[0]!)).toBe(true);
  });
});
