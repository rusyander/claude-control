import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splitTicketKey } from '@agentdeck/contracts/split-tickets';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';
import { atlassianTicketTracker } from '../domains/chat/split-ticket-tracker.ts';
import { writeLink } from '../domains/integrations/links.ts';
import { writeSettings, writeToken } from '../domains/integrations/store.ts';
import type { SplitPlanRecord } from '../lib/app-store/app-store.types.ts';

/**
 * «Завести» предложенный группой тикет (L277) по НАСТОЯЩЕМУ пути: маршрут,
 * конвейер, хранилище, привязка проекта, интеграция и клиент Jira. Подменена
 * только сеть (`fetch`) — ответ трекера.
 *
 * Вопросы: задача заводится в привязанный проект с заголовком из записи группы;
 * отметка ложится на тот же дефект во всех группах и переживает перечитывание;
 * повтор и двойной клик второй задачи не заводят; без привязки — отказ с кодом
 * и ни одного запроса наружу.
 */

const TICKET = {
  title: 'Падает экспорт отчёта',
  where: 'apps/web/src/export.ts:42',
  why: 'пустой файл',
  at: '2026-09-25T10:30:00.000Z',
};
const KEY = splitTicketKey(TICKET);

describe('POST /api/chat/split/:parent/tickets/file', () => {
  let root: string;
  let appData: string;
  let app: FastifyInstance;
  let store: AppStore;
  let conveyor: SplitConveyor;
  let calls: { url: string; init: RequestInit }[];

  const group = (index: number): SplitPlanRecord['groups'][number] => ({
    index,
    title: `Группа ${index + 1}`,
    branch: `feature/g${index + 1}`,
    after: [],
    status: 'done',
    chatId: `child-${index + 1}`,
    tickets: [{ ...TICKET, why: index === 0 ? TICKET.why : 'тот же дефект' }],
  });

  const file = (key = KEY) =>
    app.inject({
      method: 'POST',
      url: '/api/chat/split/parent-1/tickets/file',
      payload: { key, description: 'Описание из хаба' },
    });

  /** Трекер отвечает на заведение и на чтение заведённой задачи; ответ — с задержкой. */
  function stubJira(): void {
    calls = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      await new Promise((done) => setTimeout(done, 10));
      const created = init.method === 'POST' && String(url).endsWith('/rest/api/2/issue');
      const body = created
        ? { key: 'PROJ-7' }
        : { key: 'PROJ-7', fields: { summary: TICKET.title, status: { name: 'Open' } } };
      return new Response(JSON.stringify(body), { status: created ? 201 : 200 });
    });
  }

  const creates = () => calls.filter((call) => call.init.method === 'POST');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-ticket-file-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);
    store.setSplitPlan({
      parentChatId: 'parent-1',
      projectPath: root,
      createdAt: '2026-09-25T00:00:00.000Z',
      order: [0, 1],
      request: {},
      proposal: { groups: [] },
      groups: [group(0), group(1)],
    });
    writeSettings(store, 'atlassian', {
      enabled: true,
      baseUrl: 'https://jira.example.com',
      email: 'qa@example.com',
      deployment: 'server',
      confluenceUrl: '',
    });
    writeToken(appData, 'atlassian', 'SECRET');
    const ctx = {
      location: { paths: { root, appData, mcpConfig: join(root, '.claude.json') } },
      store,
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;
    const tracker = atlassianTicketTracker(ctx);
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
      ticketTracker: (projectPath) => tracker.projectOf(projectPath),
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
      tracker,
    });
    await app.ready();
    stubJira();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('привязан проект Jira — задача заводится туда, отметка у дефекта во всех группах', async () => {
    writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });
    expect(conveyor.view(['parent-1'])?.ticketTracker).toBe('PROJ');

    const response = await file();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ key: 'PROJ-7', created: true });
    expect(creates()).toHaveLength(1);
    const sent = JSON.parse(String(creates()[0]?.init.body)) as {
      fields: { project: { key: string }; summary: string; description: string };
    };
    expect(sent.fields.project.key).toBe('PROJ');
    expect(sent.fields.summary).toBe(TICKET.title);
    expect(sent.fields.description).toBe('Описание из хаба');
    // Отметка на диске, у обеих групп: перечитанная запись и вид хаба знают ключ.
    const reopened = new AppStore(appData);
    const filed = reopened
      .getSplitPlan('parent-1')
      ?.groups.map((item) => item.tickets?.[0]?.filed?.key);
    expect(filed).toEqual(['PROJ-7', 'PROJ-7']);
    expect(conveyor.view(['parent-1'])?.groups[1]?.tickets?.[0]?.filed?.key).toBe('PROJ-7');
  });

  it('повтор и двойной клик второй задачи не заводят', async () => {
    writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });

    const [first, second] = await Promise.all([file(), file()]);
    const again = await file();

    expect(first.json()).toEqual({ key: 'PROJ-7', created: true });
    expect(second.json()).toEqual({ key: 'PROJ-7', created: false });
    expect(again.json()).toEqual({ key: 'PROJ-7', created: false });
    expect(creates()).toHaveLength(1);
  });

  it('трекер не привязан — отказ с кодом, наружу ни одного запроса', async () => {
    expect(conveyor.view(['parent-1'])?.ticketTracker).toBeUndefined();

    const response = await file();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'split-ticket-tracker-missing' });
    expect(calls).toEqual([]);
  });

  it('неизвестное предложение — отказ с кодом', async () => {
    writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });

    const response = await file('нет|такого');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'split-ticket-missing' });
    expect(calls).toEqual([]);
  });
});
