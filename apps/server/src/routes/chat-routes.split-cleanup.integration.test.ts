import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
import { LiveSession } from '../domains/chat/live-session.ts';
import { spawnDirect } from '../domains/chat/live-transport.ts';

/** Процесс, чей cwd — копия: ждёт ввода и выходит по его концу, как CLI в пуле. */
const HOLD_CWD = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";

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
  let registry: ChatRunRegistry;
  let conveyor: SplitConveyor;
  const holders: ChildProcess[] = [];

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
    registry = new ChatRunRegistry((): RunLike => ({
      start: async () => undefined,
      stop: () => undefined,
    }));
    conveyor = new SplitConveyor({
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
    registry.livePool.closeAll();
    for (const child of holders.splice(0)) child.kill();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Процесс CLI в пуле, ждущий следующего хода, с cwd в копии. */
  const pooled = (cwd: string): LiveSession => {
    const session = new LiveSession(
      {
        command: process.execPath,
        args: ['-e', HOLD_CWD],
        cwd,
        env: process.env,
        shell: false,
        signature: 'test',
      },
      Date.now,
      spawnDirect,
    );
    session.sessionId = 'pooled-session';
    registry.livePool.keep(session);
    return session;
  };
  const registered = (path: string): boolean =>
    git(repo, 'worktree', 'list', '--porcelain')
      .replace(/\\/g, '/')
      .toLowerCase()
      .includes(path.replace(/\\/g, '/').toLowerCase());

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

  // Живой прогон 25.09 (F4c): CLI, ждущий следующего хода, держал копию своим
  // cwd; Windows не отдавал её, и `git worktree remove` оставлял полкопии.
  it('простаивающий CLI в копии закрывается, и копия уходит целиком', async () => {
    const session = pooled(paths[0]!);

    const response = await cleanup(0);

    expect(response.statusCode).toBe(200);
    expect(session.alive).toBe(false);
    expect(existsSync(paths[0]!)).toBe(false);
    expect(registered(paths[0]!)).toBe(false);
  }, 30_000);

  it('CLI в копии занят ходом — отказ, процесс и копия целы', async () => {
    const session = pooled(paths[0]!);
    void session.turn('ход', undefined, () => undefined);

    const response = await cleanup(0);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'worktree-agent-running' });
    expect(session.alive).toBe(true);
    expect(existsSync(join(paths[0]!, 'a.txt'))).toBe(true);
  });

  // Держит не наш процесс — закрыть его панели нечем. Отказ ДО git: раньше
  // git успевал стереть файлы и снять копию с учёта. Замок каталога — только у
  // Windows; на других ОС удаление из-под cwd проходит, и вопроса нет.
  it.skipIf(process.platform !== 'win32')(
    'копию держит чужой процесс — отказ кодом, файлы и учёт копии целы',
    async () => {
      const holder = spawn(process.execPath, ['-e', HOLD_CWD], { cwd: paths[0]!, stdio: 'pipe' });
      holders.push(holder);
      await new Promise((done) => holder.once('spawn', done));

      const response = await cleanup(0);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ messageCode: 'worktree-copy-locked' });
      expect(existsSync(join(paths[0]!, 'a.txt'))).toBe(true);
      expect(registered(paths[0]!)).toBe(true);
    },
    30_000,
  );

  it('незакоммиченная правка в копии — отказ кодом, а не сырым git', async () => {
    writeFileSync(join(paths[0]!, 'draft.txt'), 'правка\n', 'utf8');

    const response = await cleanup(0);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'worktree-copy-dirty' });
    expect(existsSync(join(paths[0]!, 'draft.txt'))).toBe(true);
  });

  it('непредвиденный отказ git — кодом, с текстом git в параметре', async () => {
    // Сломанная ссылка копии на репозиторий: git отказывается снимать её сам.
    // Файл `.git` копии скрытый, а Windows не перезаписывает скрытые — сносим.
    rmSync(join(paths[0]!, '.git'));
    writeFileSync(join(paths[0]!, '.git'), 'не ссылка\n', 'utf8');

    const response = await cleanup(0);

    expect(response.statusCode).toBe(409);
    const body = response.json() as { messageCode?: string; params?: { detail?: string } };
    expect(body.messageCode).toBe('split-group-cleanup-failed');
    expect(body.params?.detail).toBeTruthy();
  });

  // F5.2: новое разделение того же разговора затирало запись плана, и копии
  // старых групп оставались на диске без кнопки уборки — сиротами.
  it('копия группы прошлого разделения убирается по чату после нового плана', async () => {
    store.setChatLink('child-2', {
      parentChatId: 'parent-1',
      createdAt: '2026-09-23T00:00:00.000Z',
    });
    store.retireChatLink('child-2');
    await conveyor.begin({
      parentChatId: 'parent-1',
      projectPath: repo,
      request: {},
      proposal: {
        groups: [
          { title: 'Новая 1', branch: 'feature/new-a', tasks: ['раз'] },
          { title: 'Новая 2', branch: 'feature/new-b', tasks: ['два'] },
        ],
      },
    });
    const fresh = store.getSplitPlan('parent-1')!;
    // Все четыре старые группы с неубранной копией переживают новый план.
    expect(fresh.groups.map((item) => item.title)).toEqual(['Новая 1', 'Новая 2']);
    expect(fresh.retiredGroups?.map((item) => item.chatId)).toEqual([
      'child-1',
      'child-2',
      'child-3',
      'child-4',
    ]);

    // Номер 1 теперь у новой группы без копии — старую он не достаёт.
    const byIndex = await cleanup(1);
    expect(byIndex.statusCode).toBe(409);
    expect(existsSync(paths[1]!)).toBe(true);

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split/parent-1/cleanup',
      payload: { chatId: 'child-2' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ branch: 'kept' });
    expect(existsSync(paths[1]!)).toBe(false);
    expect(hasBranch('feature/work')).toBe(true);
    const after = store.getSplitPlan('parent-1')!;
    expect(after.retiredGroups?.find((item) => item.chatId === 'child-2')?.cleaned).toBeTruthy();
    expect(after.groups.every((item) => !item.cleaned)).toBe(true);

    const again = await app.inject({
      method: 'POST',
      url: '/api/chat/split/parent-1/cleanup',
      payload: { chatId: 'child-2' },
    });
    expect(again.json()).toMatchObject({ messageCode: 'split-cleanup-nothing' });
  }, 30_000);

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
