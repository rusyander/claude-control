import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { atlassianTaskTracker } from '../domains/chat/split-ticket-tracker.ts';
import { writeSettings, writeToken } from '../domains/integrations/store.ts';
import type { SplitPlanRecord } from '../lib/app-store/app-store.types.ts';

/**
 * «Перевести задачи» (G4) по НАСТОЯЩЕМУ пути: маршрут, запись плана в
 * хранилище, интеграция и клиент Jira. Подменена только сеть (`fetch`) —
 * Jira в памяти со статусами и переходами.
 *
 * Вопросы: ключи берутся из записи плана (группы без MR не участвуют, тело
 * запроса чужой ключ не подсунет); кнопка группы — её задачи, шапка — все;
 * перевод идёт тем переходом, что ведёт в выбранный статус; без Jira, без
 * статуса и с кривым номером группы — отказ с кодом и ни одного запроса наружу.
 */

const FLOW: Record<string, { id: string; name: string; to: { name: string } }[]> = {
  'In Progress': [
    { id: '21', name: 'На ревью', to: { name: 'Review' } },
    { id: '31', name: 'Закрыть', to: { name: 'Done' } },
  ],
  Review: [{ id: '41', name: 'Принять', to: { name: 'Done' } }],
};

describe('/api/chat/split/:parent/tasks', () => {
  let root: string;
  let appData: string;
  let app: FastifyInstance;
  let store: AppStore;
  let conveyor: SplitConveyor;
  let statuses: Record<string, string>;
  let calls: { method: string; url: string; body?: string }[];

  const group = (
    index: number,
    extra: Partial<SplitPlanRecord['groups'][number]> = {},
  ): SplitPlanRecord['groups'][number] => ({
    index,
    title: `Группа ${index + 1}`,
    branch: `feature/g${index + 1}`,
    after: [],
    status: 'done',
    chatId: `child-${index + 1}`,
    mr: `https://git.example.com/mr/${index + 1}`,
    ...extra,
  });

  /** Jira в памяти: чтение задачи, её переходы и сам переход меняют статус. */
  function stubJira(): void {
    calls = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url: String(url), body: init.body ? String(init.body) : undefined });
      const match = /\/issue\/([^/?]+)(\/transitions)?/.exec(String(url));
      const key = decodeURIComponent(match?.[1] ?? '');
      const status = statuses[key];
      if (!status) return new Response('{"errorMessages":["нет задачи"]}', { status: 404 });
      if (match?.[2] && method === 'POST') {
        const id = (JSON.parse(String(init.body)) as { transition: { id: string } }).transition.id;
        const to = FLOW[status]?.find((item) => item.id === id);
        if (!to) return new Response('{"errorMessages":["переход недоступен"]}', { status: 400 });
        statuses[key] = to.to.name;
        return new Response(null, { status: 204 });
      }
      const body = match?.[2]
        ? { transitions: FLOW[status] ?? [] }
        : { key, fields: { summary: key, status: { name: status } } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
  }

  const options = (index?: number) =>
    app.inject({
      method: 'GET',
      url: `/api/chat/split/parent-1/tasks${index === undefined ? '' : `?index=${index}`}`,
    });
  const move = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/chat/split/parent-1/tasks/move', payload });
  const writes = () => calls.filter((call) => call.method === 'POST');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-tasks-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);
    store.setSplitPlan({
      parentChatId: 'parent-1',
      projectPath: root,
      createdAt: '2026-10-05T00:00:00.000Z',
      order: [0, 1, 2, 3],
      request: {},
      proposal: {
        groups: [
          { title: 'Г1', branch: 'b1', tasks: ['Сделать PROJ-1'] },
          { title: 'Г2', branch: 'b2', tasks: ['Сделать PROJ-2'] },
          { title: 'Г3', branch: 'b3', tasks: ['Сделать PROJ-3'] },
          { title: 'Г4', branch: 'b4', tasks: ['Без ключа трекера'] },
        ],
      },
      groups: [group(0), group(1), group(2, { mr: undefined }), group(3)],
    });
    store.setSplitPlan({
      parentChatId: 'child-2',
      projectPath: root,
      createdAt: '2026-10-05T00:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'В1', branch: 'v1', tasks: ['SUB-1'] }] },
      groups: [group(0, { chatId: 'grandchild-1', title: 'Вложенная' })],
    });
    statuses = {
      'PROJ-1': 'In Progress',
      'PROJ-2': 'Review',
      'PROJ-3': 'In Progress',
      'SUB-1': 'In Progress',
    };
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
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async () => undefined,
      stop: () => undefined,
    }));
    const tasks = atlassianTaskTracker(
      () => ctx.store,
      () => ctx.location.paths.appData,
    );
    conveyor = new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (ids) => store.findSplitPlanByTriage(ids),
        all: () => store.getSplitPlans(),
      },
      tasksConnected: () => tasks.connected(),
      launch: async () => ({ chats: [], failures: [] }),
      startTriage: () => ({ chatId: '', started: false, deferred: false }),
      log: () => undefined,
    });
    app = Fastify();
    registerChatSplitRoutes(app, ctx, {
      runs: registry,
      providerChats: new ProviderChatService(),
      session: new ChatSession(registry),
    });
    await app.ready();
    stubJira();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('вид хаба: задачи у групп с ключами — MR не нужен; кнопка — пока Jira подключена', async () => {
    const view = conveyor.view(['parent-1']);
    expect(view?.jiraTasks).toBe(true);
    expect(view?.groups.map((item) => item.taskKeys)).toEqual([
      ['PROJ-1'],
      ['PROJ-2'],
      ['PROJ-3'],
      undefined,
    ]);
    writeSettings(store, 'atlassian', {
      enabled: false,
      baseUrl: 'https://jira.example.com',
      email: 'qa@example.com',
      deployment: 'server',
      confluenceUrl: '',
    });
    expect(conveyor.view(['parent-1'])?.jiraTasks).toBeUndefined();
  });

  it('шапка: задачи всех групп и вложенного разделения, статусы — общие и «из статуса»', async () => {
    const response = await options();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      keys: [
        { key: 'PROJ-1', group: 'Группа 1', status: 'In Progress' },
        { key: 'PROJ-2', group: 'Группа 2', status: 'Review' },
        { key: 'SUB-1', group: 'Вложенная', status: 'In Progress' },
        { key: 'PROJ-3', group: 'Группа 3', status: 'In Progress' },
      ],
      // Review: PROJ-2 уже там, остальные переходом. Done — всем переходом.
      statuses: ['Review', 'Done'],
      from: [
        { status: 'In Progress', count: 3, targets: ['Review', 'Done'] },
        { status: 'Review', count: 1, targets: ['Done'] },
      ],
      unread: [],
    });
    // Чтение — без единой записи.
    expect(writes()).toEqual([]);
  });

  it('кнопка группы — только её задача', async () => {
    const response = await options(1);
    expect(response.json().keys).toEqual([{ key: 'PROJ-2', group: 'Группа 2', status: 'Review' }]);
    expect(response.json().statuses).toEqual(['Done']);
  });

  it('перевод шапки: переход, ведущий в статус, у каждой задачи; уже стоящая не трогается', async () => {
    const response = await move({ status: 'Review' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'Review',
      items: [
        { key: 'PROJ-1', outcome: 'moved' },
        { key: 'PROJ-2', outcome: 'already' },
        { key: 'SUB-1', outcome: 'moved' },
        { key: 'PROJ-3', outcome: 'moved' },
      ],
    });
    expect(writes().map((call) => [call.url.split('/issue/')[1], call.body])).toEqual([
      ['PROJ-1/transitions', '{"transition":{"id":"21"}}'],
      ['SUB-1/transitions', '{"transition":{"id":"21"}}'],
      ['PROJ-3/transitions', '{"transition":{"id":"21"}}'],
    ]);
    expect(statuses).toMatchObject({
      'PROJ-1': 'Review',
      'PROJ-3': 'Review',
      'SUB-1': 'Review',
    });
  });

  it('«из статуса»: переводятся только задачи, что стоят в нём; прочие не трогаются', async () => {
    const response = await move({ status: 'Done', from: 'Review' });

    expect(response.json()).toEqual({
      status: 'Done',
      from: 'Review',
      items: [
        { key: 'PROJ-1', outcome: 'skipped', reason: 'In Progress' },
        { key: 'PROJ-2', outcome: 'moved' },
        { key: 'SUB-1', outcome: 'skipped', reason: 'In Progress' },
        { key: 'PROJ-3', outcome: 'skipped', reason: 'In Progress' },
      ],
    });
    expect(writes().map((call) => call.url.split('/issue/')[1])).toEqual(['PROJ-2/transitions']);
    expect(statuses).toMatchObject({ 'PROJ-1': 'In Progress', 'PROJ-2': 'Done' });
  });

  it('перевод группы трогает только её задачу; ключи из тела запроса не принимаются', async () => {
    const response = await move({ index: 0, status: 'Done', keys: ['PROJ-3'] });

    expect(response.json().items).toEqual([{ key: 'PROJ-1', outcome: 'moved' }]);
    expect(writes()).toHaveLength(1);
    expect(statuses['PROJ-3']).toBe('In Progress');
  });

  it('недоступный переход и ошибка Jira — по задаче, остальные переводятся', async () => {
    delete statuses['PROJ-2'];
    statuses['SUB-1'] = 'Done';

    const response = await move({ status: 'Review' });

    expect(response.json().items).toEqual([
      { key: 'PROJ-1', outcome: 'moved' },
      { key: 'PROJ-2', outcome: 'failed', reason: expect.any(String) },
      { key: 'SUB-1', outcome: 'unavailable' },
      { key: 'PROJ-3', outcome: 'moved' },
    ]);
    expect(statuses['PROJ-1']).toBe('Review');
  });

  it('отказы с кодом и без единого запроса наружу', async () => {
    const noStatus = await move({ status: '  ' });
    expect(noStatus.statusCode).toBe(400);
    expect(noStatus.json().messageCode).toBe('split-tasks-status-missing');

    const badIndex = await app.inject({
      method: 'GET',
      url: '/api/chat/split/parent-1/tasks?index=abc',
    });
    expect(badIndex.statusCode).toBe(400);
    expect(badIndex.json().messageCode).toBe('split-tasks-index-bad');
    const badMoveIndex = await move({ index: '1x', status: 'Done' });
    expect(badMoveIndex.json().messageCode).toBe('split-tasks-index-bad');

    const noKeysGroup = await options(3);
    expect(noKeysGroup.statusCode).toBe(409);
    expect(noKeysGroup.json().messageCode).toBe('split-tasks-none');

    const noPlan = await app.inject({ method: 'GET', url: '/api/chat/split/nobody/tasks' });
    expect(noPlan.statusCode).toBe(404);
    expect(noPlan.json().messageCode).toBe('split-levels-missing');

    writeSettings(store, 'atlassian', {
      enabled: false,
      baseUrl: 'https://jira.example.com',
      email: 'qa@example.com',
      deployment: 'server',
      confluenceUrl: '',
    });
    const off = await move({ status: 'Done' });
    expect(off.statusCode).toBe(404);
    expect(off.json().messageCode).toBe('split-tasks-jira-off');

    expect(calls).toEqual([]);
  });
});
