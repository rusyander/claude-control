import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
 * «Принять» доставленную группу (TK-accepted) поверх НАСТОЯЩИХ маршрута,
 * конвейера и хранилища. Приёмка ручная: отметку ставит только эта ручка, она
 * переживает перечитывание записи, повтор её не сдвигает, «Снять отметку»
 * снимает, а новый ход группы снимает сам — принимали прошлую работу.
 */
describe('POST /api/chat/split/:parent/accept', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let conveyor: SplitConveyor;

  const group = (
    index: number,
    status: SplitPlanRecord['groups'][number]['status'],
  ): SplitPlanRecord['groups'][number] => ({
    index,
    title: `Группа ${index + 1}`,
    branch: `feature/g${index + 1}`,
    after: [],
    status,
    chatId: `child-${index + 1}`,
  });

  const accept = (index: number, accepted?: boolean) =>
    app.inject({
      method: 'POST',
      url: '/api/chat/split/parent-1/accept',
      payload: { index, ...(accepted === undefined ? {} : { accepted }) },
    });

  const viewOf = (index: number) => conveyor.view(['parent-1'])?.groups[index];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-accept-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'parent-1',
      projectPath: root,
      createdAt: '2026-09-25T00:00:00.000Z',
      order: [0, 1],
      request: {},
      proposal: { groups: [] },
      groups: [group(0, 'done'), group(1, 'started')],
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
    rmSync(root, { recursive: true, force: true });
  });

  it('доставленная группа принимается: отметка в записи и в виде для хаба', async () => {
    const response = await accept(0);

    expect(response.statusCode).toBe(200);
    const body = response.json() as { index: number; acceptedAt?: string };
    expect(body.index).toBe(0);
    expect(typeof body.acceptedAt).toBe('string');
    // Хранилище — источник: перечитанная запись и вид хаба несут то же время.
    expect(store.getSplitPlan('parent-1')?.groups[0]?.acceptedAt).toBe(body.acceptedAt);
    expect(viewOf(0)?.acceptedAt).toBe(body.acceptedAt);
    // Отметка на диске, а не только в памяти: переживает перезапуск сервера.
    const reopened = new AppStore(join(root, 'agentdeck'));
    expect(reopened.getSplitPlan('parent-1')?.groups[0]?.acceptedAt).toBe(body.acceptedAt);
  });

  it('повторное «Принять» — то же время, а не новое (вторая вкладка, второй клик)', async () => {
    const first = (await accept(0)).json() as { acceptedAt?: string };
    // Маршрут берёт настоящие часы: пауза, чтобы новое время отличалось.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await accept(0);

    expect(second.statusCode).toBe(200);
    expect((second.json() as { acceptedAt?: string }).acceptedAt).toBe(first.acceptedAt);
  });

  it('недоставленную группу принять нельзя — отказ с кодом, отметки нет', async () => {
    const response = await accept(1);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'split-accept-not-done' });
    expect(store.getSplitPlan('parent-1')?.groups[1]?.acceptedAt).toBeUndefined();
    expect(viewOf(1)?.acceptedAt).toBeUndefined();
  });

  it('«Снять отметку» снимает; повтор у непринятой — не ошибка', async () => {
    await accept(0);
    const undo = await accept(0, false);

    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toEqual({ index: 0 });
    expect(store.getSplitPlan('parent-1')?.groups[0]?.acceptedAt).toBeUndefined();
    expect(viewOf(0)?.acceptedAt).toBeUndefined();
    expect((await accept(0, false)).statusCode).toBe(200);
  });

  it('новый ход принятой группы снимает отметку: принимали прошлую работу', async () => {
    await accept(0);
    conveyor.onChainResumed({
      parentChatId: 'parent-1',
      createdAt: '2026-09-25T00:00:00.000Z',
      groupIndex: 0,
      branch: 'feature/g1',
    });

    expect(viewOf(0)?.status).toBe('started');
    expect(viewOf(0)?.acceptedAt).toBeUndefined();
  });
});
