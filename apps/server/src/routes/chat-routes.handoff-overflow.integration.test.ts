import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatHandoffRoutes } from './chat/handoff-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import type { SplitPlanRecord } from '../lib/app-store/app-store.types.ts';

/**
 * Переполненный родитель разделения (живой прогон 25.09.2026): контекст вырос
 * до «Prompt is too long», и родитель не принимал ни одного сообщения — ни
 * слова человека, ни передачи группам. «Продолжить в новой сессии» заводит
 * свежий разговор сразу (просьбу обновить опору переполненный не примет), и
 * разделение переезжает к нему: запись, связи групп, сводка в первом ходе.
 *
 * Маршрут, реестр прогонов и хранилище — настоящие; подменён только процесс CLI.
 */
describe('перезапуск переполненного разговора', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let started: { chatId: string; prompt: string }[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-overflow-'));
    project = mkdtempSync(join(tmpdir(), 'cc-overflow-proj-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    started = [];
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({ chatId: options.permissionPrompt?.runId ?? '', prompt: options.prompt });
      },
      stop: () => undefined,
    }));
    store = new AppStore(join(root, 'agentdeck'));
    // Сводка — по записи, лежащей ПОД ключом прогона: так её ищет конвейер
    // (`view` сравнивает `parentChatId` с ключами), без следования переездам.
    registry.setChildrenBriefResolver((keys) =>
      keys.some((key) => store.getSplitPlans()[key]?.parentChatId === key)
        ? '<agentdeck-children>СВОДКА ГРУПП</agentdeck-children>'
        : undefined,
    );
    registry.setSessionListener((chatId, sessionId) => store.linkChatSession(chatId, sessionId));
    const ctx = {
      location: {
        paths: {
          root,
          appData: join(root, 'agentdeck'),
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatHandoffRoutes(app, ctx, {
      runs: registry,
      chains: new HandoffChains(),
      providerChats: new ProviderChatService(),
      session: new ChatSession(registry),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function splitParent(parent: string): void {
    store.setSplitPlan({
      parentChatId: parent,
      projectPath: project,
      createdAt: '2026-09-25T10:00:00.000Z',
      order: [0, 1],
      request: {},
      proposal: { groups: [] },
      groups: [
        { index: 0, status: 'running', chatId: 'g-0' },
        { index: 1, status: 'done', chatId: 'g-1' },
      ],
    } as unknown as SplitPlanRecord);
    for (const [chatId, groupIndex] of [
      ['g-0', 0],
      ['g-1', 1],
    ] as const) {
      store.setChatLink(chatId, {
        parentChatId: parent,
        groupIndex,
        createdAt: '2026-09-25T10:00:00.000Z',
      });
    }
  }

  async function restart(chatId: string, overflow: boolean) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/${chatId}/restart`,
      payload: { projectPath: project, sessionId: chatId, allowEdits: true, overflow },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ mode: string; chatId?: string }>();
  }

  it('родитель разделения: свежая сессия сразу, группы переезжают, первый ход со сводкой', async () => {
    splitParent('parent-1');

    const outcome = await restart('parent-1', true);

    expect(outcome.mode).toBe('started');
    const next = outcome.chatId as string;
    expect(store.getSplitPlans()[next]?.parentChatId).toBe(next);
    expect(store.getSplitPlans()['parent-1']).toBeUndefined();
    expect(store.getChatLink('g-0')?.parentChatId).toBe(next);
    expect(store.getChatLink('g-1')?.parentChatId).toBe(next);
    expect(started).toHaveLength(1);
    expect(started[0]?.chatId).toBe(next);
    expect(started[0]?.prompt).toContain('СВОДКА ГРУПП');
    expect(started[0]?.prompt).toContain('Работа этого разговора идёт в группах разделения');
    expect(started[0]?.prompt).toContain('agentdeck:tell');
  });

  it('ход конвейера со старым ключом ложится к новому родителю, а не рядом', async () => {
    splitParent('parent-1');
    const stale = store.getSplitPlan('parent-1') as SplitPlanRecord;

    const next = (await restart('parent-1', true)).chatId as string;
    store.setSplitPlan({ ...stale, groups: [...stale.groups] });

    expect(Object.keys(store.getSplitPlans())).toEqual([next]);
    expect(store.getSplitPlan('parent-1')?.parentChatId).toBe(next);
  });

  it('настоящий id сессии продолжения забирает запись у временного ключа', async () => {
    splitParent('parent-1');
    const next = (await restart('parent-1', true)).chatId as string;

    store.linkChatSession(next, 'sess-fresh');

    expect(Object.keys(store.getSplitPlans())).toEqual(['sess-fresh']);
    expect(store.getChatLink('g-0')?.parentChatId).toBe('sess-fresh');
  });

  it('обычный чат: сразу свежая сессия по опоре, записи разделения не появляется', async () => {
    const outcome = await restart('plain-1', true);

    expect(outcome.mode).toBe('started');
    expect(store.getSplitPlans()).toEqual({});
    expect(started[0]?.prompt).toContain('Продолжай работу по .agent/PROGRESS.md');
    expect(started[0]?.prompt).not.toContain('СВОДКА ГРУПП');
  });

  it('без переполнения опора несвежая — как раньше, просьба агенту', async () => {
    splitParent('parent-1');

    const outcome = await restart('parent-1', false);

    expect(outcome.mode).toBe('requested');
    expect(started).toHaveLength(0);
    expect(store.getSplitPlans()['parent-1']).toBeDefined();
  });
});
