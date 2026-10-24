import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splitTicketKey } from '@agentdeck/contracts/split-tickets';
import type { SplitTicketPublished } from '@agentdeck/contracts/split-ticket-batch';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerChatSplitRoutes } from '../chat/split-routes.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import { SplitConveyor } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import { atlassianTicketTracker } from '../../domains/chat/split-ticket-tracker.ts';
import { writeLink } from '../../domains/integrations/links.ts';
import { writeSettings, writeToken } from '../../domains/integrations/store/store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  capabilityRefusal,
  ROUTE_LEDGER,
} from '../panel-agent/capability-ledger/capability-ledger.ts';

/**
 * «Разобрать…» в хабе по НАСТОЯЩЕМУ пути: маршруты, конвейер, хранилище,
 * интеграция, клиент Jira, реестр прогонов. Подменены только сеть (`fetch` —
 * ответы трекера), ответ модели (`ticketAsk`) и процесс CLI (RunLike).
 *
 * Вопросы: публикация заводит задачи по ответу модели с приоритетом и меткой и
 * отмечает находки во всех группах на диске; двойной клик не заводит второй
 * раз; открытая задача про то же получает комментарий, а не копию; упавшая задача остаётся открытой и «Повторить упавшие» заводит ровно её
 * без второго прохода модели; без Jira — отказ без запроса наружу; «куда
 * заводить» берёт привязку и прячет подзадачи; «Решить здесь» запускает один
 * чат с находками и отмечает их взятыми; агенту панели все три ручки закрыты.
 */

const EXPORT = {
  title: 'Падает экспорт отчёта',
  where: 'apps/web/src/export.ts:42',
  why: 'пустой файл',
  at: '2026-09-25T10:30:00.000Z',
};
const BUTTON = {
  title: 'Кнопка «Сохранить» не нажимается',
  where: 'apps/web/src/save.tsx:7',
  why: 'disabled навсегда',
  at: '2026-09-25T10:31:00.000Z',
};
const PARENT = '/api/chat/split/parent-1';

describe('POST /api/chat/split/:parent/tickets/{target,publish,take}', () => {
  let root: string;
  let appData: string;
  let app: FastifyInstance;
  let store: AppStore;
  let calls: { url: string; init: RequestInit }[];
  let failSummary: string | undefined;
  let asks: string[];
  let started: RunOptions[];
  let modelReply: string;
  /** Открытые задачи проекта, которые вернёт поиск Jira. */
  let openIssues: { key: string; fields: { summary: string; description?: string } }[];

  const group = (index: number): SplitPlanRecord['groups'][number] => ({
    index,
    title: `Группа ${index + 1}`,
    branch: `feature/g${index + 1}`,
    after: [],
    status: 'done',
    chatId: `child-${index + 1}`,
    // Экспорт нашли обе группы (один ключ), кнопку — только первая.
    // Копии: отметки ложатся на объекты записи, константы между проверками не делятся.
    tickets:
      index === 0
        ? [{ ...EXPORT }, { ...BUTTON }]
        : [{ ...EXPORT, why: 'тот же дефект другими словами' }],
  });

  const publish = (payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `${PARENT}/tickets/publish`,
      payload: { projectKey: 'PROJ', issueType: 'Bug', lang: 'ru', ...payload },
    });
  const take = () =>
    app.inject({ method: 'POST', url: `${PARENT}/tickets/take`, payload: { lang: 'ru' } });

  /**
   * Ответ модели: каждая связка — своя задача. Ссылки берутся из данных
   * (хвост промпта после правил), не из примера ответа в самих правилах.
   */
  const perCluster = (prompt: string): string => {
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n'))) as { id: string }[];
    const ids = data.map((bundle) => bundle.id);
    return JSON.stringify({
      issues: ids.map((id, n) => ({
        title: `Задача ${n + 1}`,
        summary: 'Описание модели',
        area: ['frontend'],
        severity: n === 0 ? 'high' : 'low',
        sources: [id],
      })),
    });
  };

  function stubJira(): void {
    calls = [];
    let next = 1;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      await new Promise((done) => setTimeout(done, 5));
      const path = new URL(String(url)).pathname;
      if (init.method === 'POST' && path.endsWith('/rest/api/2/issue')) {
        const sent = JSON.parse(String(init.body)) as { fields: { summary: string } };
        if (failSummary && sent.fields.summary === failSummary) {
          return new Response(JSON.stringify({ errorMessages: ['Jira упала'] }), { status: 500 });
        }
        return new Response(JSON.stringify({ key: `PROJ-${next++}` }), { status: 201 });
      }
      if (path.endsWith('/rest/api/2/search')) return Response.json({ issues: openIssues });
      if (init.method === 'POST' && /\/rest\/api\/2\/issue\/[^/]+\/comment$/.test(path)) {
        return new Response(JSON.stringify({ id: '1' }), { status: 201 });
      }
      if (path.endsWith('/rest/api/2/project')) {
        return Response.json([
          { id: '1', key: 'OTHER', name: 'Other' },
          { id: '2', key: 'PROJ', name: 'Project' },
        ]);
      }
      if (path.endsWith('/rest/api/2/project/PROJ')) {
        return Response.json({
          issueTypes: [{ name: 'Sub-task', subtask: true }, { name: 'Task' }, { name: 'Bug' }],
        });
      }
      if (path.endsWith('/rest/api/2/priority')) {
        return Response.json([{ name: 'Highest' }, { name: 'High' }, { name: 'Low' }]);
      }
      const key = decodeURIComponent(path.split('/').pop() ?? '');
      return Response.json({ key, fields: { summary: 'x', status: { name: 'Open' } } });
    });
  }

  const creates = () =>
    calls
      .filter(
        (call) =>
          call.init.method === 'POST' && new URL(call.url).pathname.endsWith('/rest/api/2/issue'),
      )
      .map(
        (call) =>
          JSON.parse(String(call.init.body)) as {
            fields: {
              project: { key: string };
              summary: string;
              description: string;
              labels?: string[];
              priority?: { name: string };
              issuetype: { name: string };
            };
          },
      );

  const marksOnDisk = () =>
    new AppStore(appData)
      .getSplitPlan('parent-1')
      ?.groups.map((item) =>
        (item.tickets ?? []).map((ticket) => ticket.filed?.key ?? ticket.taken?.chatId ?? null),
      );

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-ticket-batch-'));
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
    failSummary = undefined;
    asks = [];
    started = [];
    modelReply = '';
    openIssues = [];
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
      start: async (options) => {
        started.push(options);
      },
      stop: () => undefined,
    }));
    const conveyor = new SplitConveyor({
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
      ticketAsk: async (prompt) => {
        asks.push(prompt);
        return modelReply || perCluster(prompt);
      },
    });
    await app.ready();
    stubJira();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('публикация: задачи по ответу модели, приоритет и метка, отметки во всех группах на диске', async () => {
    const response = await publish();

    expect(response.statusCode).toBe(200);
    const body = response.json<SplitTicketPublished>();
    expect(body.mode).toBe('model');
    expect(body.failed).toEqual([]);
    expect(body.issues.map((issue) => [issue.key, issue.url, issue.created])).toEqual([
      ['PROJ-1', 'https://jira.example.com/browse/PROJ-1', true],
      ['PROJ-2', 'https://jira.example.com/browse/PROJ-2', true],
    ]);
    expect(asks).toHaveLength(1);
    // Повтор экспорта из второй группы модель не видит отдельной находкой.
    expect(asks[0]).toContain(EXPORT.title);
    expect(asks[0]).toContain(BUTTON.title);
    const sent = creates();
    expect(sent).toHaveLength(2);
    expect(sent.map((issue) => issue.fields.project.key)).toEqual(['PROJ', 'PROJ']);
    expect(sent.map((issue) => issue.fields.issuetype.name)).toEqual(['Bug', 'Bug']);
    expect(sent.map((issue) => issue.fields.priority?.name)).toEqual(['High', 'Low']);
    expect(sent[0]?.fields.labels).toEqual(['frontend', 'agentdeck-proposal']);
    expect(sent[0]?.fields.description).toContain('Описание модели');
    // Ключ задачи — у экспорта в ОБЕИХ группах, у кнопки — в первой.
    const exportKey = body.issues.find((issue) =>
      issue.proposals.includes(splitTicketKey(EXPORT)),
    )?.key;
    const buttonKey = body.issues.find((issue) =>
      issue.proposals.includes(splitTicketKey(BUTTON)),
    )?.key;
    expect(marksOnDisk()).toEqual([[exportKey, buttonKey], [exportKey]]);
  });

  it('двойной клик: каждая задача заводится один раз, второй ответ — «открытых нет»', async () => {
    const both = await Promise.all([publish(), publish()]);
    // Какой из двух встал в очередь первым — не важно: важно, что один.
    const [first, second] = [...both].sort((a, b) => a.statusCode - b.statusCode);
    if (!first || !second) throw new Error('two responses expected');

    expect(first.statusCode).toBe(200);
    expect(first.json<SplitTicketPublished>().issues).toHaveLength(2);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ messageCode: 'split-ticket-batch-empty' });
    expect(creates()).toHaveLength(2);
    expect(asks).toHaveLength(1);
  });

  it('открытая задача про то же уже есть: поиск до заведения, комментарий в неё, копии нет', async () => {
    openIssues = [
      { key: 'PROJ-9', fields: { summary: 'Падает экспорт отчётов', description: 'от человека' } },
    ];

    const response = await publish();

    expect(response.statusCode).toBe(200);
    const body = response.json<SplitTicketPublished>();
    const search = calls.find((call) => new URL(call.url).pathname.endsWith('/search'));
    expect(new URL(search?.url ?? 'http://x').searchParams.get('jql')).toBe(
      'project = "PROJ" AND statusCategory != Done ORDER BY updated DESC',
    );
    const comment = calls.find((call) => call.url.endsWith('/rest/api/2/issue/PROJ-9/comment'));
    const text = (JSON.parse(String(comment?.init.body)) as { body: string }).body;
    expect(text).toContain('1. Падает экспорт отчёта\nГде: apps/web/src/export.ts:42');
    expect(text).toContain('agentdeck-fp:');
    // Заведена только кнопка; экспорт ушёл комментарием и отмечен ключом открытой задачи.
    expect(creates().map((issue) => issue.fields.summary)).toEqual(['Задача 2']);
    expect(body.issues).toEqual([
      expect.objectContaining({ key: 'PROJ-9', created: false, commented: true }),
      expect.objectContaining({ key: 'PROJ-1', created: true }),
    ]);
    expect(marksOnDisk()).toEqual([['PROJ-9', 'PROJ-1'], ['PROJ-9']]);
    // Отметка помнит, что это комментарий: строка хаба подпишет «уже была открыта».
    const commented = new AppStore(appData)
      .getSplitPlan('parent-1')
      ?.groups.map((item) => item.tickets?.map((ticket) => ticket.filed?.commented ?? false));
    expect(commented).toEqual([[true, false], [true]]);
  });

  it('упавшая задача остаётся открытой; «Повторить упавшие» заводит ровно её без модели', async () => {
    failSummary = 'Задача 2';

    const firstRun = await publish();

    expect(firstRun.statusCode).toBe(200);
    const partial = firstRun.json<SplitTicketPublished>();
    expect(partial.issues.map((issue) => issue.key)).toEqual(['PROJ-1']);
    expect(partial.failed).toHaveLength(1);
    expect(partial.failed[0]?.title).toBe('Задача 2');
    expect(partial.failed[0]?.message).toMatch(/Jira/);
    const failedKeys = partial.failed[0]?.proposals ?? [];
    expect(failedKeys).toHaveLength(1);
    // На диске упавшая находка без отметки.
    const flat = marksOnDisk()?.flat();
    expect(flat?.filter((mark) => mark === null).length).toBeGreaterThan(0);

    failSummary = undefined;
    const retry = await publish({ retryFailed: true });

    expect(retry.statusCode).toBe(200);
    const fixed = retry.json<SplitTicketPublished>();
    expect(fixed.failed).toEqual([]);
    expect(fixed.issues).toEqual([
      expect.objectContaining({ key: 'PROJ-2', title: 'Задача 2', proposals: failedKeys }),
    ]);
    expect(asks).toHaveLength(1);
    expect(creates().map((issue) => issue.fields.summary)).toEqual([
      'Задача 1',
      'Задача 2',
      'Задача 2',
    ]);
    expect(marksOnDisk()?.flat()).not.toContain(null);
  });

  it('модель ответила не JSON — по задаче на склейку, без модели', async () => {
    modelReply = 'извините, не могу';

    const response = await publish();

    expect(response.statusCode).toBe(200);
    const body = response.json<SplitTicketPublished>();
    expect(body.mode).toBe('fallback');
    expect(
      creates()
        .map((issue) => issue.fields.summary)
        .sort(),
    ).toEqual([BUTTON.title, EXPORT.title].sort());
  });

  it('Jira не подключена — публикация отказывает с кодом, наружу ни одного запроса', async () => {
    writeSettings(store, 'jira', {
      enabled: false,
      baseUrl: 'https://jira.example.com',
      email: 'qa@example.com',
      deployment: 'server',
    });

    const response = await publish();
    const target = await app.inject({ method: 'GET', url: `${PARENT}/tickets/target` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ messageCode: 'integration-not-connected' });
    expect(target.json()).toEqual({ connected: false, projects: [], issueTypes: [] });
    expect(calls).toEqual([]);
    expect(asks).toEqual([]);
  });

  it('без проекта Jira в запросе — 400, ни модели, ни трекера', async () => {
    const response = await publish({ projectKey: '  ' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ messageCode: 'request-jira-project-missing' });
    expect(calls).toEqual([]);
    expect(asks).toEqual([]);
  });

  it('куда заводить: привязка проекта выигрывает у последнего, подзадачи скрыты, Bug по умолчанию', async () => {
    writeLink(store, root, undefined, { jiraProjectKey: 'PROJ' });

    const response = await app.inject({
      method: 'GET',
      url: `${PARENT}/tickets/target?last=OTHER`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connected: true,
      site: 'https://jira.example.com',
      projects: [
        { key: 'OTHER', name: 'Other' },
        { key: 'PROJ', name: 'Project' },
      ],
      projectKey: 'PROJ',
      projectFrom: 'bound',
      issueTypes: ['Task', 'Bug'],
      issueType: 'Bug',
    });
    expect(calls.every((call) => (call.init.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('«Решить здесь»: один новый чат с находками, отметки «взято», повтор — «открытых нет»', async () => {
    const response = await take();

    expect(response.statusCode).toBe(200);
    const body = response.json<{ chatId: string; count: number }>();
    expect(body.chatId).toMatch(/^new-/);
    expect(body.count).toBe(2);
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd).toBe(root);
    expect(started[0]?.permissionMode).toBe('default');
    expect(started[0]?.prompt).toContain(EXPORT.title);
    expect(started[0]?.prompt).toContain(BUTTON.title);
    expect(started[0]?.prompt).toContain(EXPORT.where);
    expect(marksOnDisk()).toEqual([[body.chatId, body.chatId], [body.chatId]]);

    const again = await take();
    const publishAfter = await publish();

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ messageCode: 'split-ticket-batch-empty' });
    expect(publishAfter.statusCode).toBe(409);
    expect(started).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('агенту панели все три ручки закрыты: кнопки человека', () => {
    for (const [method, url] of [
      ['GET', `${PARENT}/tickets/target`],
      ['POST', `${PARENT}/tickets/publish`],
      ['POST', `${PARENT}/tickets/take`],
    ] as const) {
      expect(
        capabilityRefusal(ROUTE_LEDGER, 'start_chat', 'execute', { method, url }),
        `${method} ${url}`,
      ).toMatch(/This step is the human’s/);
    }
  });
});
