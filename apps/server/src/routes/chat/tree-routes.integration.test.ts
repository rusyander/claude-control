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
});
