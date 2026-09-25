import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatAutoModeView } from '@agentdeck/contracts';
import type { ChatAwaitingView, ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { sandboxRoot } from '../../domains/chat/ChatArtifacts.ts';
import { TreePause } from '../../domains/chat/tree-pause.ts';
import {
  hasParentLink,
  PENDING_ASKS_FILE,
  wirePendingAsks,
} from '../../domains/chat/pending-asks.ts';
import { registerChatRoutes } from '../chat-routes.ts';
import { registerChatTreeRoutes } from './tree-routes.ts';

/**
 * Авторежим прав во всех чатах (владелец, 24.09.2026) поверх НАСТОЯЩИХ
 * маршрутов: отправка, тумблер чата, запрос прав, дерево. Подменён только CLI —
 * прогон, который называет сессию и живёт, пока тест его не закончит. Вопрос
 * ровно в том, с каким `--permission-mode` уйдёт прогон и что панель ответит на
 * запрос прав, поэтому ни то ни другое не заглушено. «Перезапуск панели» —
 * новые реестр, состояние чата и приложение над тем же каталогом данных.
 */
describe('авторежим прав чата', () => {
  let root: string;
  let data: string;
  let work: string;
  let store: AppStore;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  let runs: { options: RunOptions; end: () => void }[];
  const PLAIN = 'new-auto-plain';
  const CHILD = 'new-auto-child';

  const boot = async (): Promise<void> => {
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) =>
        new Promise<void>((resolve) => {
          const id = options.permissionPrompt?.runId ?? 'x';
          onEvent({ kind: 'session', sessionId: `sess-${id}`, model: '', tools: 0 });
          runs.push({ options, end: resolve });
        }),
      stop: () => undefined,
    }));
    registry.setSessionListener((chatId, sessionId) => store.linkChatSession(chatId, sessionId));
    const asks = wirePendingAsks(registry, {
      file: join(data, PENDING_ASKS_FILE),
      // Тот же предикат, что собирает `bootstrap/runtime.ts`.
      isTreeChat: hasParentLink((key) => store.getChatLink(key)),
    });
    registry.setStartListener((keys) => asks.started(keys));
    const tree = new TreePause({
      links: () => store.getChatLinks(),
      runs: registry,
      store: {
        get: (key) => store.getTreePause(key),
        all: () => store.getTreePauses(),
        set: (record) => store.setTreePause(record),
        clear: (key) => store.clearTreePause(key),
      },
      asksOf: (keys) => asks.of(keys, (runId) => registry.isRunning(runId)),
    });
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          appData: data,
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRoutes(app, ctx, registry, new ChatSession(registry, data));
    registerChatTreeRoutes(app, ctx, tree);
    await app.ready();
  };

  const restart = async (): Promise<void> => {
    registry.stopAll();
    await app.close();
    runs = [];
    await boot();
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-auto-mode-'));
    data = join(root, 'agentdeck');
    work = join(root, 'work');
    mkdirSync(data, { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(join(root, 'projects'), { recursive: true });
    runs = [];
    store = new AppStore(data);
    await boot();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    for (const id of [PLAIN, CHILD])
      rmSync(join(sandboxRoot(), id), { recursive: true, force: true });
  });

  const tick = (ms = 30) => new Promise((done) => setTimeout(done, ms));

  /** Отправка из вкладки: прогон живёт, поэтому поток не ждём. */
  const send = async (chatId: string, extra: Record<string, unknown> = {}): Promise<RunOptions> => {
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId, prompt: 'работай', projectPath: work, allowEdits: true, ...extra },
    });
    await tick();
    const run = runs.findLast((item) => item.options.permissionPrompt?.runId === chatId);
    if (!run) throw new Error(`no run ${chatId}`);
    return run.options;
  };

  const toggle = (chatId: string, enabled: boolean) =>
    app.inject({ method: 'POST', url: `/api/chat/${chatId}/auto-approve`, payload: { enabled } });

  /**
   * Что панель ответит на запрос прав: `allow` сама или карточка человеку.
   * Карточку снимаем отказом — иначе запрос висел бы до конца теста.
   */
  const decide = async (runId: string, command: string): Promise<string> => {
    const toolUseId = `toolu_${Math.random().toString(36).slice(2)}`;
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId, toolName: 'Bash', input: { command }, toolUseId },
    });
    const result = await Promise.race([
      pending.then((response) => response.json<{ behavior: string }>().behavior),
      tick(80).then(() => 'card'),
    ]);
    if (result === 'card') {
      await app.inject({
        method: 'POST',
        url: `/api/chat/${runId}/permission-decision`,
        payload: { toolUseId, behavior: 'deny' },
      });
      await pending;
    }
    return result;
  };

  it('по умолчанию: CLI в авторежиме, рутину панель подтверждает сама', async () => {
    expect((await send(PLAIN)).permissionMode).toBe('auto');
    expect(await decide(PLAIN, 'npm test')).toBe('allow');
  });

  it('глобально выключен — acceptEdits, рутина спрашивает человека', async () => {
    store.updateSettings({ chatAutoMode: false });
    expect((await send(PLAIN)).permissionMode).toBe('acceptEdits');
    expect(await decide(PLAIN, 'npm test')).toBe('card');
  });

  it('выключенный в чате сильнее включённого глобально — и переживает перезапуск', async () => {
    await toggle(PLAIN, false);
    const view = (
      await app.inject({ method: 'GET', url: `/api/chat/${PLAIN}/auto-mode` })
    ).json<ChatAutoModeView>();
    expect(view).toEqual({ enabled: false, override: false, global: true });

    expect((await send(PLAIN)).permissionMode).toBe('acceptEdits');
    expect(await decide(PLAIN, 'npm test')).toBe('card');

    // Перезапуск: выбор чата — на диске, а не в памяти прогона.
    await restart();
    expect((await send(PLAIN)).permissionMode).toBe('acceptEdits');
  });

  it('включённый в чате сильнее выключенного глобально', async () => {
    store.updateSettings({ chatAutoMode: false });
    await toggle(PLAIN, true);
    expect((await send(PLAIN)).permissionMode).toBe('auto');
    expect(await decide(PLAIN, 'npm test')).toBe('allow');
  });

  it('haiku: CLI опустил бы авторежим до default — acceptEdits и автоподтверждение панели', async () => {
    expect((await send(PLAIN, { model: 'haiku' })).permissionMode).toBe('acceptEdits');
    expect(await decide(PLAIN, 'npm test')).toBe('allow');
  });

  it('чужой CLI: без флага авторежима — acceptEdits и автоподтверждение панели', async () => {
    store.updateSettings({ provider: 'codex' });
    expect((await send(PLAIN)).permissionMode).toBe('acceptEdits');
    expect(await decide(PLAIN, 'npm test')).toBe('allow');
  });

  it('безвозвратное в авторежиме уходит человеку, и чат из родителя показывает запрос в его хабе', async () => {
    // Чат, заведённый из родителя вручную, — не группа разделения: связь ему
    // ставит сама отправка (`parentChatId`).
    await send(CHILD, { parentChatId: 'parent' });
    const toolUseId = 'toolu_rollback';
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: {
        runId: CHILD,
        toolName: 'Bash',
        input: { command: 'git checkout -- package-lock.json && git status' },
        toolUseId,
      },
    });
    await tick();

    const tree = (
      await app.inject({ method: 'GET', url: '/api/chat/parent/tree' })
    ).json<ChatTreeView>();
    const node = tree.nodes.find((item) => item.chatId === `sess-${CHILD}`);
    expect(node?.asks).toEqual([
      expect.objectContaining({ kind: 'permission', runId: CHILD, toolUseId }),
    ]);
    const awaiting = (
      await app.inject({ method: 'GET', url: '/api/chat/awaiting' })
    ).json<ChatAwaitingView>();
    expect(awaiting.chats).toEqual([
      expect.objectContaining({ parentChatId: 'parent', kind: 'permission' }),
    ]);

    await app.inject({
      method: 'POST',
      url: `/api/chat/${CHILD}/permission-decision`,
      payload: { toolUseId, behavior: 'deny' },
    });
    expect((await pending).json()).toMatchObject({ behavior: 'deny' });
  });
});
