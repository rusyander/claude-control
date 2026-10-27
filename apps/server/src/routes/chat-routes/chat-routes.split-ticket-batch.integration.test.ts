import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { fingerprintOf } from '../../domains/chat/split-ticket-batch/compose.ts';
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

/**
 * Хэш-подобные токены текста: 7+ шестнадцатеричных знаков подряд, отдельным
 * словом или частью через дефис, с цифрой и буквой a–f (слова и даты — мимо).
 */
function machineIds(text: string): string[] {
  return [...text.matchAll(/(?<![0-9a-z])[0-9a-f]{7,}(?![0-9a-z])/gi)]
    .map((match) => match[0])
    .filter((token) => /\d/.test(token) && /[a-f]/i.test(token));
}

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
  /** Ответ поиска по похожим (JQL с `summary ~` / `text ~`). */
  let similarIssues: { key: string; fields: { summary: string; description?: string } }[];
  /** Jira отвергает поле приоритета (экран заведения без него): 400 `errors.priority`. */
  let rejectPriority: boolean;
  /** Исполнитель проекта по умолчанию, которого Jira ставит сама. */
  let defaultAssignee: string | undefined;

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
        const sent = JSON.parse(String(init.body)) as {
          fields: { summary: string; priority?: unknown };
        };
        if (rejectPriority && sent.fields.priority) {
          return new Response(
            JSON.stringify({
              errorMessages: [],
              errors: {
                priority: "Field 'priority' cannot be set. It is not on the appropriate screen.",
              },
            }),
            { status: 400 },
          );
        }
        if (failSummary && sent.fields.summary === failSummary) {
          return new Response(JSON.stringify({ errorMessages: ['Jira упала'] }), { status: 500 });
        }
        return new Response(JSON.stringify({ key: `PROJ-${next++}` }), { status: 201 });
      }
      if (path.endsWith('/rest/api/2/search')) {
        const jql = new URL(String(url)).searchParams.get('jql') ?? '';
        return Response.json({ issues: / ~ "/.test(jql) ? similarIssues : openIssues });
      }
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
      return Response.json({
        key,
        fields: {
          summary: 'x',
          status: { name: 'Open' },
          ...(defaultAssignee ? { assignee: { displayName: defaultAssignee } } : {}),
        },
      });
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
              assignee?: unknown;
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
    similarIssues = [];
    rejectPriority = false;
    defaultAssignee = undefined;
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
    // Только словесные метки: машинной метки разделения в Jira нет (владелец 26.10.2026).
    expect(sent[0]?.fields.labels).toEqual(['frontend', 'agentdeck-proposal']);
    // Исполнителя панель не ставит никогда: поля нет в теле вовсе.
    for (const issue of sent) expect(Object.keys(issue.fields)).not.toContain('assignee');
    expect(sent[0]?.fields.description.split('\n\n')[0]).toBe(
      'Сторона: FRONTEND — фронтенд\nСерьёзность: high → приоритет Jira «High»',
    );
    expect(sent[0]?.fields.description).toContain('Контекст: Описание модели');
    expect(body.issues.map((issue) => [issue.side, issue.priority])).toEqual([
      ['frontend', 'High'],
      ['frontend', 'Low'],
    ]);
    expect(body.issues.some((issue) => issue.assignee)).toBe(false);
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
    // Отпечаток находки в комментарий не уходит (владелец 26.10.2026): он в памяти панели.
    expect(text).not.toContain('agentdeck-fp');
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

  it('вторая публикация тех же находок узнаёт задачи по памяти панели, хотя их переименовали', async () => {
    const first = await publish();
    expect(first.statusCode).toBe(200);
    const filed = first.json<SplitTicketPublished>().issues.map((issue) => issue.key);
    expect(filed).toEqual(['PROJ-1', 'PROJ-2']);
    // Память на диске, в каталоге данных панели: задача → отпечатки её находок.
    const memory = JSON.parse(
      readFileSync(join(appData, 'split-ticket-prints.json'), 'utf8'),
    ) as Record<string, string[]>;
    expect(Object.keys(memory).sort()).toEqual(['PROJ-1', 'PROJ-2']);
    // Те же находки снова (новое разделение), задачи в Jira переименованы, в тексте отпечатков нет.
    store.setSplitPlan({ ...store.getSplitPlan('parent-1')!, groups: [group(0), group(1)] });
    openIssues = filed.map((key) => ({
      key,
      fields: { summary: `Переименовано человеком ${key}`, description: 'текст без отпечатка' },
    }));
    calls = [];

    const second = await publish();

    expect(second.statusCode).toBe(200);
    expect(creates()).toEqual([]);
    const commented = calls
      .filter((call) => call.url.endsWith('/comment'))
      .map((call) => new URL(call.url).pathname.split('/').at(-2));
    expect(commented.sort()).toEqual(['PROJ-1', 'PROJ-2']);
    expect(second.json<SplitTicketPublished>().issues.every((issue) => !issue.created)).toBe(true);
  });

  it('в Jira не уходит ни одного внутреннего машинного id: метки, название, описание, комментарий', async () => {
    // Владелец 26.10.2026: хэш-метки (`agentdeck-split-<hex>`), id чатов и короткие
    // sha живут только в наших инструментах. Проверяется то, что ушло по сети,
    // без исключений: отпечатки находок тоже остаются в памяти панели.
    openIssues = [
      { key: 'PROJ-9', fields: { summary: 'Падает экспорт отчётов', description: 'от человека' } },
    ];

    const response = await publish();

    expect(response.statusCode).toBe(200);
    const sent = creates();
    expect(sent.length).toBeGreaterThan(0);
    const commentBodies = calls
      .filter((call) => call.url.endsWith('/comment'))
      .map((call) => (JSON.parse(String(call.init.body)) as { body: string }).body);
    expect(commentBodies.length).toBeGreaterThan(0);
    const published = [
      ...sent.flatMap((issue) => issue.fields.labels ?? []),
      ...sent.map((issue) => issue.fields.summary),
      ...[...sent.map((issue) => issue.fields.description), ...commentBodies].flatMap((text) =>
        text.split('\n'),
      ),
    ];
    expect(published.filter((text) => text.includes('agentdeck-fp'))).toEqual([]);
    expect(
      published.filter((text) => text.includes('agentdeck-split-') || machineIds(text).length > 0),
    ).toEqual([]);
    // Сама проверка краснеет на том, что ловит: прежняя метка и короткий sha.
    expect(machineIds('agentdeck-split-357fa91c')).toEqual(['357fa91c']);
    expect(machineIds('коммит 3bb94ad, чат 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b')).toEqual([
      '3bb94ad',
      '0f1e2d3c',
      '0c1d2e3f4a5b',
    ]);
    expect(machineIds('agentdeck-proposal frontend 2026-10-26 Medium')).toEqual([]);
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

  it('Jira отвергла поле приоритета — та же задача заводится второй раз без него, не теряется', async () => {
    rejectPriority = true;

    const response = await publish();

    expect(response.statusCode).toBe(200);
    const body = response.json<SplitTicketPublished>();
    expect(body.failed).toEqual([]);
    expect(body.issues.map((issue) => [issue.key, issue.priority])).toEqual([
      ['PROJ-1', undefined],
      ['PROJ-2', undefined],
    ]);
    const posted = calls
      .filter(
        (call) =>
          call.init.method === 'POST' && new URL(call.url).pathname.endsWith('/rest/api/2/issue'),
      )
      .map(
        (call) => (JSON.parse(String(call.init.body)) as { fields: { priority?: unknown } }).fields,
      );
    expect(posted.map((fields) => Boolean(fields.priority))).toEqual([true, false, true, false]);
    // Серьёзность не пропала: меткой и строкой описания.
    const second = posted[1] as { labels?: string[]; description?: string };
    expect(second.labels).toContain('severity-high');
    expect(second.description).toContain('Серьёзность: high');
  });

  it('Jira сама назначила исполнителя проекта — итог называет его', async () => {
    defaultAssignee = 'Руководитель проекта';

    const response = await publish();

    const body = response.json<SplitTicketPublished>();
    expect(body.issues.map((issue) => issue.assignee)).toEqual([
      'Руководитель проекта',
      'Руководитель проекта',
    ]);
    for (const issue of creates()) expect(Object.keys(issue.fields)).not.toContain('assignee');
  });

  it('проверка на повторы: только чтение, похожая открытая задача видна до публикации', async () => {
    similarIssues = [{ key: 'PROJ-5', fields: { summary: 'Кнопка «Сохранить» зависает' } }];
    openIssues = [{ key: 'PROJ-9', fields: { summary: 'Падает экспорт отчётов' } }];

    const response = await app.inject({
      method: 'GET',
      url: `${PARENT}/tickets/duplicates?project=PROJ`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      duplicates: [
        expect.objectContaining({
          proposals: [splitTicketKey(EXPORT)],
          title: EXPORT.title,
          reason: 'title',
          issue: expect.objectContaining({
            key: 'PROJ-9',
            url: 'https://jira.example.com/browse/PROJ-9',
          }),
        }),
        expect.objectContaining({
          proposals: [splitTicketKey(BUTTON)],
          title: BUTTON.title,
          reason: 'similar',
          issue: expect.objectContaining({ key: 'PROJ-5' }),
        }),
      ],
    });
    expect(calls.every((call) => (call.init.method ?? 'GET') === 'GET')).toBe(true);
    const jqls = calls
      .filter((call) => new URL(call.url).pathname.endsWith('/search'))
      .map((call) => new URL(call.url).searchParams.get('jql'));
    expect(jqls).toEqual([
      'project = "PROJ" AND statusCategory != Done ORDER BY updated DESC',
      expect.stringMatching(
        /^project = "PROJ" AND statusCategory != Done AND \(summary ~ "[^"]+" OR text ~ "[0-9a-f]{6,40}"\)$/,
      ),
    ]);
  });

  it('проверка на повторы по памяти панели: ключ задачи уходит в поиск, чужие и кривые ключи — нет', async () => {
    const print = fingerprintOf(splitTicketKey(BUTTON));
    writeFileSync(
      join(appData, 'split-ticket-prints.json'),
      JSON.stringify({
        'PROJ-31': [print],
        'OTHER-4': [print],
        'PROJ-1) OR (project = SECRET': [print],
      }),
    );
    // Задачу переименовали, отпечатка в тексте нет: узнать её можно только по памяти.
    similarIssues = [{ key: 'PROJ-31', fields: { summary: 'Совсем другое название' } }];

    const response = await app.inject({
      method: 'GET',
      url: `${PARENT}/tickets/duplicates?project=PROJ`,
    });

    expect(response.statusCode).toBe(200);
    const found = response.json<{
      duplicates: { title: string; reason: string; issue: { key: string } }[];
    }>().duplicates;
    expect(found.find((item) => item.title === BUTTON.title)).toMatchObject({
      reason: 'fingerprint',
      issue: { key: 'PROJ-31' },
    });
    const jqls = calls
      .filter((call) => new URL(call.url).pathname.endsWith('/search'))
      .map((call) => new URL(call.url).searchParams.get('jql') ?? '');
    const buttonSearch = jqls.find((jql) => jql.includes(print));
    expect(buttonSearch).toContain('key in (PROJ-31)');
    expect(jqls.some((jql) => jql.includes('OTHER-4') || jql.includes('SECRET'))).toBe(false);
  });

  it('решения человека: «пропустить» не пишет ничего, «связать» — комментарий в выбранную', async () => {
    const response = await publish({
      duplicates: [
        { proposal: splitTicketKey(EXPORT), choice: 'link', issueKey: 'PROJ-9' },
        { proposal: splitTicketKey(BUTTON), choice: 'skip', issueKey: 'PROJ-5' },
        { proposal: 'мусор', choice: 'delete' },
      ],
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<SplitTicketPublished>();
    expect(creates()).toEqual([]);
    expect(asks).toEqual([]);
    const commented = calls.filter((call) => call.url.endsWith('/comment')).map((call) => call.url);
    expect(commented).toEqual(['https://jira.example.com/rest/api/2/issue/PROJ-9/comment']);
    expect(body.skipped).toEqual([expect.objectContaining({ title: BUTTON.title, key: 'PROJ-5' })]);
    // Пропущенная кнопка осталась открытой — её можно опубликовать позже.
    expect(marksOnDisk()).toEqual([['PROJ-9', null], ['PROJ-9']]);
  });

  it('агенту панели все ручки закрыты: кнопки человека', () => {
    for (const [method, url] of [
      ['GET', `${PARENT}/tickets/target`],
      ['GET', `${PARENT}/tickets/duplicates`],
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
