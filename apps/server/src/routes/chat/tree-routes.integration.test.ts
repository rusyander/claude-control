import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTreeResumePrompt } from '@agentdeck/contracts/chat-handoff';
import type {
  ChatTreePaused,
  ChatTreeResumed,
  ChatTreeView,
} from '@agentdeck/contracts/chat-handoff';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner.ts';
import { TreePause } from '../../domains/chat/tree-pause.ts';
import { carriedLink } from '../../lib/app-store/chat-links.ts';
import { createTreeRuns } from '../../domains/chat/tree-runs.ts';
import { ProviderChatService, createChat } from '../../domains/provider-chat.ts';
import type { ConfigProvider } from '../../providers/types.ts';
import { registerChatTreeRoutes } from './tree-routes.ts';

/**
 * Маршруты паузы дерева поверх НАСТОЯЩЕГО реестра и хранилища: прогоны-заглушки
 * называют сессию и висят, пока их не остановят — как живой CLI между ответами.
 */
describe('маршруты паузы дерева', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let started: RunOptions[];
  let stopped: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-tree-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    started = [];
    stopped = 0;
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) => {
        started.push(options);
        const id = options.permissionPrompt?.runId ?? 'x';
        // Сессия названа сразу; продолжение (`--resume`) свою не переименовывает.
        onEvent({
          kind: 'session',
          sessionId: options.sessionId ?? `sess-${id}`,
          model: '',
          tools: 0,
        });
        return new Promise(() => undefined);
      },
      stop: () => {
        stopped += 1;
      },
    }));
    store = new AppStore(join(root, 'agentdeck'));
    registry.setSessionListener((chatId, sessionId) => store.linkChatSession(chatId, sessionId));
    const tree = new TreePause({
      links: () => store.getChatLinks(),
      runs: registry,
      store: {
        get: (key) => store.getTreePause(key),
        all: () => store.getTreePauses(),
        set: (record) => store.setTreePause(record),
        clear: (key) => store.clearTreePause(key),
      },
    });
    app = Fastify();
    registerChatTreeRoutes(app, { store } as unknown as ServerContext, tree);
    await app.ready();

    // Родитель `parent` с двумя детьми разделения; все трое идут.
    const start = (chatId: string, prompt: string) =>
      registry.start(
        chatId,
        { prompt, cwd: root, permissionPrompt: { runId: chatId, baseUrl: 'http://x' } },
        { projectPath: root },
      );
    store.setChatLink('new-1', {
      parentChatId: 'parent',
      title: 'Форма',
      createdAt: '2026-09-09T10:00:00.000Z',
    });
    store.setChatLink('new-2', {
      parentChatId: 'parent',
      title: 'Сборка',
      createdAt: '2026-09-09T10:00:01.000Z',
    });
    start('parent', 'разбор');
    start('new-1', 'форма');
    start('new-2', 'сборка');
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('пауза останавливает всё дерево, запись переживает перезапуск, продолжение идёт в те же сессии', async () => {
    const before = (
      await app.inject({ method: 'GET', url: '/api/chat/new-1/tree' })
    ).json<ChatTreeView>();
    expect(before.root).toBe('parent');
    expect(before.running).toBe(3);
    // Ребёнок известен списку под ключом сессии, временный — в псевдонимах.
    expect(before.nodes.map((node) => node.chatId).sort()).toEqual(['sess-new-1', 'sess-new-2']);
    expect(before.nodes.find((node) => node.chatId === 'sess-new-1')?.aliases).toEqual(['new-1']);

    const paused = await app.inject({ method: 'POST', url: '/api/chat/parent/tree/pause' });
    expect(paused.statusCode).toBe(200);
    expect(paused.json<ChatTreePaused>()).toEqual({
      root: 'parent',
      stopped: 3,
      chats: 3,
      alreadyPaused: false,
    });
    expect(stopped).toBe(3);
    expect(registry.isRunning('new-1')).toBe(false);

    const view = (
      await app.inject({ method: 'GET', url: '/api/chat/sess-new-2/tree' })
    ).json<ChatTreeView>();
    expect(view.running).toBe(0);
    expect(view.paused).toMatchObject({ chats: 3, pending: 0 });

    // Запись — в state.json: новый экземпляр хранилища читает её.
    const reread = new AppStore(join(root, 'agentdeck'));
    expect(Object.keys(reread.getTreePause('parent')?.chats ?? {}).sort()).toEqual([
      'new-1',
      'new-2',
      'parent',
    ]);

    started = [];
    const resumed = await app.inject({ method: 'POST', url: '/api/chat/parent/tree/resume' });
    expect(resumed.json<ChatTreeResumed>()).toEqual({
      root: 'parent',
      wasPaused: true,
      resumed: 3,
      flushed: 0,
    });
    expect(started.map((options) => options.sessionId).sort()).toEqual([
      'sess-new-1',
      'sess-new-2',
      'sess-parent',
    ]);
    expect(new Set(started.map((options) => options.prompt))).toEqual(
      new Set([buildTreeResumePrompt()]),
    );
    expect(store.getTreePause('parent')).toBeUndefined();
    expect(registry.isRunning('new-1')).toBe(true);

    const again = (
      await app.inject({ method: 'POST', url: '/api/chat/parent/tree/resume' })
    ).json<ChatTreeResumed>();
    expect(again.wasPaused).toBe(false);
  });

  it('поле, записанное под одним ключом разговора, не раздваивает узел (Д11)', async () => {
    // Так пишет конвейер (`saveLink`/`markReviewed`): новой связью под одним
    // ключом — и содержимое двух ключей одного разговора расходится.
    const link = store.getChatLink('sess-new-1');
    if (!link) throw new Error('связь не переехала на ключ сессии');
    store.setChatLink('sess-new-1', { ...link, plannedAt: '2026-09-09T11:00:00.000Z' });

    const view = (
      await app.inject({ method: 'GET', url: '/api/chat/new-2/tree' })
    ).json<ChatTreeView>();

    expect(view.nodes.map((node) => node.chatId).sort()).toEqual(['sess-new-1', 'sess-new-2']);
    expect(view.nodes.find((node) => node.chatId === 'sess-new-1')?.aliases).toEqual(['new-1']);
  });

  it('продолжение наследует родителя, но не ключ разговора: это отдельный узел (Д11)', async () => {
    // Так связь переезжает на продолжение («перейти в чистый чат»): тем же
    // родителем и назначением, но это ДРУГОЙ разговор.
    const link = store.getChatLink('sess-new-1');
    if (!link) throw new Error('связь не переехала на ключ сессии');
    store.setChatLink('next-1', { ...carriedLink(link), groupIndex: 3 });

    const view = (
      await app.inject({ method: 'GET', url: '/api/chat/new-2/tree' })
    ).json<ChatTreeView>();

    expect(view.nodes.map((node) => node.chatId).sort()).toEqual([
      'next-1',
      'sess-new-1',
      'sess-new-2',
    ]);
    // Номер группы — ключ строки хаба у чужого CLI (Д12).
    expect(view.nodes.find((node) => node.chatId === 'next-1')?.groupIndex).toBe(3);
  });
});

/**
 * То же дерево у ЧУЖОГО CLI (Т2). Маршрут, домен и вид ответа те же — меняется
 * только реализация прогонов, и выбирается она по ключу связи.
 */
describe('дерево у чужого провайдера', () => {
  let root: string;
  let appData: string;
  let app: FastifyInstance;
  let store: AppStore;
  let chats: ProviderChatService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-tree-foreign-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);
    chats = new ProviderChatService(() => ({
      start: () => new Promise<void>(() => undefined),
      stop: () => undefined,
    }));

    const tree = new TreePause({
      links: () => store.getChatLinks(),
      runs: createTreeRuns({
        registry: new ChatRunRegistry((): RunLike => ({
          start: async () => undefined,
          stop: () => undefined,
        })),
        chats,
        appDataDir: () => appData,
        provider: () => ({ id: 'codex' }) as unknown as ConfigProvider,
        models: () => [],
      }),
      store: {
        get: (key) => store.getTreePause(key),
        all: () => store.getTreePauses(),
        set: (record) => store.setTreePause(record),
        clear: (key) => store.clearTreePause(key),
      },
    });
    app = Fastify();
    registerChatTreeRoutes(app, { store } as unknown as ServerContext, tree);
    await app.ready();

    for (const id of ['c1', 'c2']) createChat(appData, 'codex', { id, workdir: root });
    store.setChatLink('codex:c1', {
      parentChatId: 'codex:parent',
      title: 'Форма',
      branch: 'split/form',
      stage: 'work',
      createdAt: '2026-09-09T10:00:00.000Z',
    });
    store.setChatLink('codex:c2', {
      parentChatId: 'codex:parent',
      title: 'Сборка',
      branch: 'split/build',
      stage: 'work',
      createdAt: '2026-09-09T10:00:01.000Z',
    });
  });

  afterEach(async () => {
    chats.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('маршрут отвечает по чужому родителю: дети, их звенья и кто идёт', async () => {
    chats.send(appData, 'codex', 'c1', { text: 'Задание' }, {
      provider: { id: 'codex' },
    } as unknown as Parameters<ProviderChatService['send']>[4]);

    const view = (
      await app.inject({
        method: 'GET',
        url: `/api/chat/${encodeURIComponent('codex:parent')}/tree`,
      })
    ).json<ChatTreeView>();

    expect(view.root).toBe('codex:parent');
    expect(view.nodes.map((node) => node.chatId)).toEqual(['codex:c1', 'codex:c2']);
    expect(view.nodes.map((node) => node.title)).toEqual(['Форма', 'Сборка']);
    expect(view.nodes.map((node) => node.stage)).toEqual(['work', 'work']);
    // Идёт ровно тот разговор, у которого идёт чужой прогон.
    expect(view.nodes.map((node) => node.running)).toEqual([true, false]);
    expect(view.running).toBe(1);
  });

  it('«голый» идентификатор родителя дерева не находит — ключ именованный', async () => {
    const view = (
      await app.inject({ method: 'GET', url: '/api/chat/parent/tree' })
    ).json<ChatTreeView>();

    expect(view.nodes).toEqual([]);
  });
});
