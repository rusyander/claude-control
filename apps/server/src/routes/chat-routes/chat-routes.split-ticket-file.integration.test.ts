import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splitTicketKey } from '@agentdeck/contracts/split-tickets';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerChatSplitRoutes } from '../chat/split-routes.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import { SplitConveyor } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import { atlassianTicketTracker } from '../../domains/chat/split-ticket-tracker.ts';
import { writeLink } from '../../domains/integrations/links.ts';
import { writeSettings, writeToken } from '../../domains/integrations/store/store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { fingerprintOf } from '../../domains/chat/split-ticket-batch/compose.ts';

/**
 * «Завести» предложенный группой тикет (L277) по НАСТОЯЩЕМУ пути: маршрут,
 * конвейер, хранилище, привязка проекта, интеграция и клиент Jira. Подменена
 * только сеть (`fetch`) — ответ трекера.
 *
 * Вопросы: задача заводится в привязанный проект с заголовком из записи группы;
 * отметка ложится на тот же дефект во всех группах и переживает перечитывание;
 * повтор и двойной клик второй задачи не заводят; без привязки — отказ с кодом
 * и ни одного запроса наружу. Сверка с открытыми задачами (R3.6): про уже
 * открытое — комментарий, а не копия (по названию и по отпечатку); новая задача
 * несёт строку отпечатка; поиск упал — не заводится ничего.
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

  /** Открытые задачи проекта, которые отдаёт поиск; `searchDown` — поиск падает. */
  let openIssues: { key: string; fields: { summary: string; description?: string } }[];
  let searchDown: boolean;

  /**
   * Трекер отвечает на поиск открытых, комментарий, заведение и чтение заведённой
   * задачи; ответ — с задержкой.
   */
  function stubJira(): void {
    calls = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      await new Promise((done) => setTimeout(done, 10));
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/rest/api/2/search')) {
        if (searchDown) {
          return new Response(JSON.stringify({ errorMessages: ['поиск упал'] }), { status: 500 });
        }
        return Response.json({ issues: openIssues });
      }
      if (init.method === 'POST' && /\/rest\/api\/2\/issue\/[^/]+\/comment$/.test(path)) {
        return new Response(JSON.stringify({ id: '1' }), { status: 201 });
      }
      const created = init.method === 'POST' && path.endsWith('/rest/api/2/issue');
      const body = created
        ? { key: 'PROJ-7' }
        : { key: 'PROJ-7', fields: { summary: TICKET.title, status: { name: 'Open' } } };
      return new Response(JSON.stringify(body), { status: created ? 201 : 200 });
    });
  }

  const creates = () =>
    calls.filter(
      (call) =>
        call.init.method === 'POST' && new URL(call.url).pathname.endsWith('/rest/api/2/issue'),
    );
  const comments = () =>
    calls.filter((call) => call.init.method === 'POST' && call.url.endsWith('/comment'));
  const searches = () => calls.filter((call) => new URL(call.url).pathname.endsWith('/search'));
  const filedOnDisk = () =>
    new AppStore(appData).getSplitPlan('parent-1')?.groups.map((item) => item.tickets?.[0]?.filed);

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
    writeSettings(store, 'jira', {
      enabled: true,
      baseUrl: 'https://jira.example.com',
      email: 'qa@example.com',
      deployment: 'server',
    });
    writeToken(appData, 'jira', 'SECRET');
    const ctx = {
      location: { paths: { root, appData, mcpConfig: join(root, '.claude.json') } },
      store,
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;
    const tracker = atlassianTicketTracker(
      () => ctx.store,
      () => ctx.location.paths.appData,
    );
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
    openIssues = [];
    searchDown = false;
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
    // Описание хаба и строка отпечатка: следующая сверка узнает задачу и после правки названия.
    expect(sent.fields.description).toBe(`Описание из хаба\n\nagentdeck-fp: ${fingerprintOf(KEY)}`);
    // Сверка с открытыми — до заведения, по проекту привязки.
    expect(searches()).toHaveLength(1);
    expect(calls.indexOf(searches()[0]!)).toBeLessThan(calls.indexOf(creates()[0]!));
    expect(new URL(searches()[0]!.url).searchParams.get('jql')).toBe(
      'project = "PROJ" AND statusCategory != Done ORDER BY updated DESC',
    );
    expect(comments()).toEqual([]);
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

  it('открыта задача с тем же названием — комментарий в неё, копия не заводится', async () => {
    writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });
    openIssues = [
      { key: 'PROJ-3', fields: { summary: 'Кнопка «Сохранить» не отвечает' } },
      { key: 'PROJ-9', fields: { summary: 'Падает экспорт отчётов', description: 'от человека' } },
    ];

    const response = await file();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ key: 'PROJ-9', created: false, commented: true });
    expect(creates()).toEqual([]);
    expect(comments().map((call) => new URL(call.url).pathname)).toEqual([
      '/rest/api/2/issue/PROJ-9/comment',
    ]);
    const text = (JSON.parse(String(comments()[0]?.init.body)) as { body: string }).body;
    expect(text).toContain('1. Падает экспорт отчёта');
    expect(text).toContain('Где: apps/web/src/export.ts:42');
    expect(text).toContain(`agentdeck-fp: ${fingerprintOf(KEY)}`);
    // Отметка — ключом открытой задачи, у обеих групп, с признаком комментария.
    expect(filedOnDisk()?.map((filed) => [filed?.key, filed?.commented])).toEqual([
      ['PROJ-9', true],
      ['PROJ-9', true],
    ]);
    // Повтор — тот же ключ, наружу больше ничего.
    const before = calls.length;
    expect((await file()).json()).toEqual({ key: 'PROJ-9', created: false });
    expect(calls).toHaveLength(before);
  });

  it('название задачи правили, но в ней отпечаток находки — комментарий туда же', async () => {
    writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });
    openIssues = [
      {
        key: 'PROJ-12',
        fields: {
          summary: 'Отчёты: пустой CSV у клиента',
          description: `разбор\n\nagentdeck-fp: 0123456789ab ${fingerprintOf(KEY)}`,
        },
      },
    ];

    const response = await file();

    expect(response.json()).toEqual({ key: 'PROJ-12', created: false, commented: true });
    expect(creates()).toEqual([]);
    expect(comments()).toHaveLength(1);
    expect(filedOnDisk()?.map((filed) => filed?.key)).toEqual(['PROJ-12', 'PROJ-12']);
  });

  it('открытые задачи о другом — заводится новая, без комментариев', async () => {
    writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });
    openIssues = [
      { key: 'PROJ-3', fields: { summary: 'Кнопка «Сохранить» не отвечает', description: '' } },
    ];

    const response = await file();

    expect(response.json()).toEqual({ key: 'PROJ-7', created: true });
    expect(comments()).toEqual([]);
    expect(creates()).toHaveLength(1);
    expect(filedOnDisk()?.map((filed) => [filed?.key, filed?.commented])).toEqual([
      ['PROJ-7', undefined],
      ['PROJ-7', undefined],
    ]);
  });

  it('поиск открытых упал — не заводится ничего, отказ человеку, повтор сверяет заново', async () => {
    writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });
    searchDown = true;

    const response = await file();

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(searches()).toHaveLength(1);
    expect(creates()).toEqual([]);
    expect(comments()).toEqual([]);
    expect(filedOnDisk()).toEqual([undefined, undefined]);

    searchDown = false;
    const again = await file();
    expect(again.json()).toEqual({ key: 'PROJ-7', created: true });
    expect(searches()).toHaveLength(2);
    expect(creates()).toHaveLength(1);
  });

  it('трекер не привязан — отказ с кодом, наружу ни одного запроса', async () => {
    expect(conveyor.view(['parent-1'])?.ticketTracker).toBeUndefined();

    const response = await file();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'split-ticket-tracker-missing' });
    expect(calls).toEqual([]);
  });

  it('каталог конфига сменили после старта — трекер по умолчанию читает новое хранилище', async () => {
    // Смена каталога подменяет ctx.store и ctx.location (`context.ts`); трекер,
    // захвативший их при регистрации, заводил бы тикеты по привязкам и доступу
    // прежнего каталога.
    const oldData = join(root, 'old-agentdeck');
    mkdirSync(oldData, { recursive: true });
    const ctx = {
      location: { paths: { root, appData: oldData, mcpConfig: join(root, '.claude.json') } },
      store: new AppStore(oldData),
      backupDir: join(oldData, 'backups'),
    } as unknown as ServerContext;
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async () => undefined,
      stop: () => undefined,
    }));
    const switched = Fastify();
    registerChatSplitRoutes(switched, ctx, {
      runs: registry,
      providerChats: new ProviderChatService(),
      session: new ChatSession(registry),
      conveyor,
    });
    await switched.ready();
    try {
      ctx.store = store;
      ctx.location = {
        ...ctx.location,
        paths: { ...ctx.location.paths, appData },
      } as ServerContext['location'];
      writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });

      const response = await switched.inject({
        method: 'POST',
        url: '/api/chat/split/parent-1/tickets/file',
        payload: { key: KEY, description: 'Описание из хаба' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ key: 'PROJ-7', created: true });
    } finally {
      await switched.close();
    }
  });

  it('неизвестное предложение — отказ с кодом', async () => {
    writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });

    const response = await file('нет|такого');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'split-ticket-missing' });
    expect(calls).toEqual([]);
  });
});
