import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type {
  PanelActionJournalEntry,
  PanelActionResult,
  PanelActionsList,
  PanelPendingAction,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import type { Project } from '@agentdeck/contracts';
import { z } from 'zod';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub, type EventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { agentJournalPath } from '../../domains/panel-agent/journal.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';
import { PANEL_ACTIONS } from './actions.ts';
import { definePanelAction, describeAction } from './registry.ts';

/**
 * Агент панели на сервере (А1) — на настоящем Fastify: тот же гейт доступа,
 * та же защита пустого тела и НАСТОЯЩИЙ маршрут проектов, которым действие
 * исполняется через `inject`. Доказательство — состояние реестра проектов и
 * файл `state.json` на диске, а не текст ответа.
 */
const ORIGIN = 'http://localhost:8888';
const TOKEN = 'test-token-panel-agent';

describe('panel-agent-routes', () => {
  let appData: string;
  let projectDir: string;
  let store: AppStore;
  let hub: EventHub;
  let frames: Array<Record<string, unknown>>;
  let pending: PanelPendingActions;
  let app: FastifyInstance;
  let tokenOn: boolean;

  const build = async (timeoutMs: number): Promise<void> => {
    store = new AppStore(appData);
    hub = createEventHub();
    frames = [];
    hub.subscribe((payload) => frames.push(JSON.parse(payload) as Record<string, unknown>));
    pending = new PanelPendingActions(timeoutMs);
    const ctx = {
      store,
      backupDir: join(appData, 'backups'),
      location: { paths: { appData } },
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => tokenOn,
      expectedToken: () => TOKEN,
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerProjectRoutes(app, ctx);
    registerPanelAgentRoutes(app, ctx, { hub, pending, access });
    await app.ready();
  };

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-appdata-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-agent-project-'));
    tokenOn = false;
    await build(10_000);
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    rmSync(appData, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const auth = (): Record<string, string> => (tokenOn ? { authorization: `Bearer ${TOKEN}` } : {});

  const call = (name: string, input: unknown, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1', ...auth() },
      payload: { input, ...extra },
    });

  const listPending = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending', headers: auth() })).json();

  /** Дождаться, пока карточка появится: вызов держит запрос открытым. */
  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [first] = await listPending();
      if (first) return first;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const decide = (id: string, decision: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/pending/${id}`,
      headers: { origin: ORIGIN, ...auth(), ...headers },
      payload: { decision },
    });

  const journalLines = (): PanelActionJournalEntry[] =>
    existsSync(agentJournalPath(appData))
      ? readFileSync(agentJournalPath(appData), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as PanelActionJournalEntry)
      : [];

  const registeredPaths = (): string[] => store.getProjects().map((project) => project.path);
  const stateOnDisk = (): string => {
    const file = join(appData, 'state.json');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };

  it('список действий: схема входа — JSON Schema, пути разделов перечислены', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent/actions' });
    expect(res.statusCode).toBe(200);
    const { actions } = res.json<PanelActionsList>();
    expect(actions.map((action) => action.name).slice(0, 5)).toEqual([
      'where_am_i',
      'list_sections',
      'open_page',
      'list_projects',
      'create_project',
    ]);
    const openPage = actions.find((action) => action.name === 'open_page');
    const route = (openPage?.inputSchema.properties as Record<string, { enum?: string[] }>).route;
    expect(route?.enum).toContain('/chat');
    expect(actions.find((action) => action.name === 'create_project')?.risk).toBe('change');
  });

  it('чтение выполняется сразу, без карточки; след пишется', async () => {
    const res = await call('list_sections', {});
    expect(res.statusCode).toBe(200);
    const body = res.json<PanelActionResult>();
    expect(body.outcome).toBe('done');
    expect((body.result as { sections: unknown[] }).sections.length).toBeGreaterThan(10);
    expect(await listPending()).toEqual([]);
    expect(journalLines()).toMatchObject([
      { name: 'list_sections', risk: 'read', outcome: 'done', decidedBy: 'auto' },
    ]);
  });

  it('list_projects идёт настоящим маршрутом и видит реестр', async () => {
    store.addProject({ id: 'p1', name: 'one', path: projectDir });
    const body = (await call('list_projects', {})).json<PanelActionResult>();
    expect(body).toMatchObject({ outcome: 'done', status: 200 });
    expect((body.result as Project[]).map((project) => project.path)).toEqual([projectDir]);
  });

  it('при включённом удалённом доступе исполнитель несёт токен сам', async () => {
    tokenOn = true;
    store.addProject({ id: 'p1', name: 'one', path: projectDir });
    const body = (await call('list_projects', {})).json<PanelActionResult>();
    expect(body.outcome).toBe('done');
    expect(body.result).toHaveLength(1);
  });

  it('open_page рассылает кадр и не требует карточки; неизвестный путь — invalid', async () => {
    const body = (
      await call('open_page', { route: '/tests', focus: 'coverage' }, { conversationId: 'c1' })
    ).json<PanelActionResult>();
    expect(body).toMatchObject({ outcome: 'done', page: { route: '/tests', focus: 'coverage' } });
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: 'agent-open-page',
        page: { route: '/tests', focus: 'coverage' },
        conversationId: 'c1',
      }),
    );

    const wrong = (await call('open_page', { route: '/nowhere' })).json<PanelActionResult>();
    expect(wrong.outcome).toBe('invalid');
    expect(frames.filter((frame) => frame.type === 'agent-open-page')).toHaveLength(1);
  });

  it('изменение без решения — таймаут, ничего не создано', async () => {
    await app.close();
    await build(150);
    const res = await call('create_project', { path: projectDir });
    expect(res.json<PanelActionResult>().outcome).toBe('timeout');
    expect(registeredPaths()).toEqual([]);
    expect(stateOnDisk()).not.toContain(JSON.stringify(projectDir).slice(1, -1));
    expect(await listPending()).toEqual([]);
    expect(journalLines().at(-1)).toMatchObject({ outcome: 'timeout', decidedBy: 'timeout' });
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'agent-decided', outcome: 'timeout' }),
    );
  });

  it('подтверждение исполняет настоящий маршрут: проект в реестре и в state.json', async () => {
    const running = call(
      'create_project',
      { path: projectDir, name: 'Демо' },
      { conversationId: 'c9' },
    );
    const card = await waitPending();
    expect(card).toMatchObject({ name: 'create_project', risk: 'change', conversationId: 'c9' });
    expect(card.preview.fields).toContainEqual({
      label: 'Название',
      labelCode: 'label-title',
      value: 'Демо',
    });
    // А9 D4: сводка и подписи кодом — английское окно не показывает русскую строку сервера.
    expect(card.preview).toMatchObject({
      summaryCode: 'summary-create-project',
      summaryParams: { title: 'Демо' },
    });
    // Пока карточка ждёт — ничего не выполнено.
    expect(registeredPaths()).toEqual([]);
    expect(frames).toContainEqual(expect.objectContaining({ type: 'agent-pending' }));

    const decision = await decide(card.id, 'approve');
    expect(decision.statusCode).toBe(200);

    const result = (await running).json<PanelActionResult>();
    expect(result).toMatchObject({ outcome: 'done', status: 200 });
    expect(registeredPaths()).toEqual([projectDir]);
    // Страница — карточка созданного проекта, а не список (D5).
    const created = new AppStore(appData).getProjects()[0];
    expect(result.page).toEqual({ route: `/projects?id=${created?.id}` });
    // Состояние на диске, а не в памяти: новое хранилище над тем же каталогом.
    expect(new AppStore(appData).getProjects().map((project) => project.name)).toEqual(['Демо']);
    // А9 D1: кадр итога называет раздел — окно перечитывает его данные.
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: 'agent-decided',
        id: card.id,
        outcome: 'done',
        section: 'projects',
      }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: 'agent-open-page',
        page: { route: `/projects?id=${created?.id}` },
      }),
    );
    expect(journalLines().at(-1)).toMatchObject({
      name: 'create_project',
      outcome: 'done',
      decidedBy: 'human',
      status: 200,
      conversationId: 'c9',
      summary: 'Добавление проекта в реестр',
      summaryCode: 'journal-create-project',
    });
  });

  it('подтверждённый вызов, отвергнутый маршрутом, — failed со статусом и текстом маршрута', async () => {
    const running = call('create_project', { path: join(projectDir, 'missing-dir') });
    const card = await waitPending();
    await decide(card.id, 'approve');
    const result = (await running).json<PanelActionResult>();
    expect(result.outcome).toBe('failed');
    expect(result.status).toBe(400);
    expect(result.message).toBeTruthy();
    expect(registeredPaths()).toEqual([]);
  });

  it('отказ человека — rejected, ничего не создано', async () => {
    const running = call('create_project', { path: projectDir });
    const card = await waitPending();
    expect((await decide(card.id, 'reject')).statusCode).toBe(200);
    expect((await running).json<PanelActionResult>().outcome).toBe('rejected');
    expect(registeredPaths()).toEqual([]);
    expect(stateOnDisk()).not.toContain('cc-agent-project-');
    expect(journalLines().at(-1)).toMatchObject({ outcome: 'rejected', decidedBy: 'human' });
  });

  it('решение с пометкой агента или без своего Origin — 403, карточка ждёт дальше', async () => {
    const running = call('create_project', { path: projectDir });
    const card = await waitPending();

    const byAgent = await decide(card.id, 'approve', { [PANEL_AGENT_HEADER]: '1' });
    expect(byAgent.statusCode).toBe(403);
    const noOrigin = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      payload: { decision: 'approve' },
    });
    expect(noOrigin.statusCode).toBe(403);
    const foreign = await decide(card.id, 'approve', { origin: 'http://localhost:5173' });
    // Чужой Origin гейт режет раньше маршрута — тоже 403.
    expect(foreign.statusCode).toBe(403);

    expect((await listPending()).map((item) => item.id)).toEqual([card.id]);
    expect(registeredPaths()).toEqual([]);

    await decide(card.id, 'reject');
    expect((await running).json<PanelActionResult>().outcome).toBe('rejected');
  });

  it('телефон: верный токен без Origin и без пометки агента — решение человека (А8)', async () => {
    tokenOn = true;
    const phone = (id: string, headers: Record<string, string>, decision = 'approve') =>
      app.inject({
        method: 'POST',
        url: `/api/agent/pending/${id}`,
        headers,
        payload: { decision },
      });
    const running = call('create_project', { path: projectDir });
    const card = await waitPending();

    // Пометка агента побеждает токен: исполнитель несёт и то и другое.
    const agentWithToken = await phone(card.id, {
      authorization: `Bearer ${TOKEN}`,
      [PANEL_AGENT_HEADER]: '1',
    });
    expect(agentWithToken.statusCode).toBe(403);
    const wrongToken = await phone(card.id, { authorization: 'Bearer not-the-token' });
    expect([401, 403]).toContain(wrongToken.statusCode);
    const queryToken = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}?token=${TOKEN}`,
      payload: { decision: 'approve' },
    });
    expect([401, 403]).toContain(queryToken.statusCode);
    expect((await listPending()).map((item) => item.id)).toEqual([card.id]);
    expect(registeredPaths()).toEqual([]);

    const approved = await phone(card.id, { authorization: `Bearer ${TOKEN}` });
    expect(approved.statusCode).toBe(200);
    expect((await running).json<PanelActionResult>()).toMatchObject({ outcome: 'done' });
    // Доказательство — реестр проектов, а не ответ маршрута.
    expect(registeredPaths()).toEqual([projectDir]);
    expect(journalLines().at(-1)).toMatchObject({ name: 'create_project', decidedBy: 'human' });
  });

  it('телефон при выключенном удалённом доступе — 403: токен не спрашивали, связывать нечего', async () => {
    const running = call('create_project', { path: projectDir });
    const card = await waitPending();
    const phone = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { decision: 'approve' },
    });
    expect(phone.statusCode).toBe(403);
    expect(registeredPaths()).toEqual([]);
    await decide(card.id, 'reject');
    expect((await running).json<PanelActionResult>().outcome).toBe('rejected');
  });

  it('create_project: тот же каталог завели руками между карточкой и кликом — stale_preview', async () => {
    const running = call('create_project', { path: projectDir, name: 'Демо' });
    const card = await waitPending();
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: projectDir, name: 'Руками' },
    });
    await decide(card.id, 'approve');
    const result = (await running).json<PanelActionResult>();
    expect(result).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
    expect(store.getProjects().map((project) => project.name)).toEqual(['Руками']);
  });

  it('повторное решение — 409, неизвестная карточка — 404, битое решение — 400', async () => {
    const running = call('create_project', { path: projectDir });
    const card = await waitPending();
    expect((await decide(card.id, 'maybe')).statusCode).toBe(400);
    expect((await decide(card.id, 'reject')).statusCode).toBe(200);
    expect((await decide(card.id, 'approve')).statusCode).toBe(409);
    expect((await decide('no-such-card', 'approve')).statusCode).toBe(404);
    expect((await running).json<PanelActionResult>().outcome).toBe('rejected');
    expect(registeredPaths()).toEqual([]);
  });

  it('неверный вход — invalid без карточки; неизвестное действие — unknown', async () => {
    const invalid = await call('create_project', { path: 42, name: 'RAW-INPUT-MARKER' });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json<PanelActionResult>()).toMatchObject({ outcome: 'invalid' });
    expect(invalid.json<PanelActionResult>().message).toContain('path');
    expect(await listPending()).toEqual([]);

    const unknown = await call('drop_database', {});
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json<PanelActionResult>().outcome).toBe('unknown');
  });

  it('след: только сводка, вход целиком не пишется; GET отдаёт свежие первыми', async () => {
    await call('open_page', { route: '/chat', focus: 'RAW-FOCUS-MARKER' });
    await call('create_project', { path: 7, name: 'RAW-INPUT-MARKER' });
    const running = call('create_project', { path: projectDir, name: 'Видимое имя' });
    await decide((await waitPending()).id, 'reject');
    await running;

    const raw = readFileSync(agentJournalPath(appData), 'utf8');
    expect(raw).not.toContain('RAW-FOCUS-MARKER');
    expect(raw).not.toContain('RAW-INPUT-MARKER');
    // Сводка карточки несёт строку модели («Видимое имя», путь) — в след не идёт.
    expect(raw).not.toContain('Видимое имя');
    expect(raw).not.toContain(JSON.stringify(projectDir).slice(1, -1));
    const allowed = new Set([
      'at',
      'name',
      'risk',
      'outcome',
      'decidedBy',
      'conversationId',
      'status',
      'summary',
      'summaryCode',
      'summaryFacts',
    ]);
    for (const line of journalLines()) {
      for (const key of Object.keys(line)) expect(allowed.has(key)).toBe(true);
    }

    const res = await app.inject({ method: 'GET', url: '/api/agent/journal?limit=2' });
    const entries = res.json<PanelActionJournalEntry[]>();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: 'create_project', outcome: 'rejected' });
    expect(entries[1]).toMatchObject({
      name: 'create_project',
      outcome: 'invalid',
      summaryCode: 'journal-invalid-input',
    });
    // Чтение пишет свою строку кодом (открытие страницы — третье снизу).
    expect(journalLines().find((line) => line.name === 'open_page')).toMatchObject({
      summaryCode: 'journal-open-page',
    });
  });

  it('обрыв клиента снимает карточку, действие не выполняется', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/api/agent/actions/create_project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_AGENT_HEADER]: '1' },
      body: JSON.stringify({ input: { path: projectDir } }),
      signal: controller.signal,
    }).catch((error: unknown) => error);

    const card = await waitPending();
    controller.abort();
    await request;

    for (let attempt = 0; attempt < 200 && (await listPending()).length > 0; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(await listPending()).toEqual([]);
    expect((await decide(card.id, 'approve')).statusCode).toBe(409);
    expect(registeredPaths()).toEqual([]);
    expect(journalLines().at(-1)).toMatchObject({ outcome: 'cancelled', decidedBy: 'client' });
  });
});

describe('panel-agent registry', () => {
  it('действие обязано иметь ровно один исполнитель и snake_case имя', () => {
    const base = { section: 's', risk: 'read' as const, description: 'd', input: z.object({}) };
    expect(() => definePanelAction({ ...base, name: 'no_executor' })).toThrow();
    expect(() =>
      definePanelAction({
        ...base,
        name: 'two_executors',
        local: () => 1,
        route: () => ({ method: 'GET', url: '/x' }),
      }),
    ).toThrow();
    expect(() => definePanelAction({ ...base, name: 'BadName', local: () => 1 })).toThrow();
  });

  it('имена в реестре уникальны, описания — схемы-объекты', () => {
    const names = PANEL_ACTIONS.map((action) => action.name);
    expect(new Set(names).size).toBe(names.length);
    for (const action of PANEL_ACTIONS) {
      expect(describeAction(action).inputSchema.type).toBe('object');
    }
  });
});

describe('panel-agent: отпечаток предпросмотра', () => {
  let appData: string;
  let app: FastifyInstance;
  let pending: PanelPendingActions;
  let target: string;
  let executed: number;

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-fp-'));
    target = 'v1';
    executed = 0;
    const action = definePanelAction({
      name: 'touch_target',
      section: 's',
      risk: 'change',
      description: 'd',
      input: z.object({}),
      route: () => ({ method: 'POST', url: '/touch' }),
      preview: () => ({ summary: `Цель ${target}`, fields: [] }),
      fingerprint: () => {
        if (target === 'gone') throw new Error('target vanished');
        return target;
      },
    });
    pending = new PanelPendingActions(10_000);
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    app = Fastify();
    app.post('/touch', () => {
      executed += 1;
      return { ok: true };
    });
    const ctx = { location: { paths: { appData } } } as unknown as ServerContext;
    registerPanelAgentRoutes(app, ctx, {
      hub: createEventHub(),
      pending,
      access,
      actions: [action],
    });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    rmSync(appData, { recursive: true, force: true });
  });

  const run = async (change?: string): Promise<PanelActionResult> => {
    const called = app.inject({
      method: 'POST',
      url: '/api/agent/actions/touch_target',
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input: {} },
    });
    let card: PanelPendingAction | undefined;
    for (let attempt = 0; attempt < 200 && !card; attempt += 1) {
      card = pending.list()[0];
      if (!card) await new Promise((done) => setTimeout(done, 5));
    }
    if (change !== undefined) target = change;
    await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card!.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });
    return (await called).json<PanelActionResult>();
  };

  it('неполная карточка: одобрить нельзя (409 preview_truncated), отклонить можно', async () => {
    const truncatedAction = definePanelAction({
      name: 'huge_edit',
      section: 's',
      risk: 'change',
      description: 'd',
      input: z.object({}),
      route: () => ({ method: 'POST', url: '/touch' }),
      preview: () => ({ summary: 'Большая правка', fields: [], truncated: true }),
    });
    await app.close();
    app = Fastify();
    app.post('/touch', () => {
      executed += 1;
      return { ok: true };
    });
    const ctx = { location: { paths: { appData } } } as unknown as ServerContext;
    registerPanelAgentRoutes(app, ctx, {
      hub: createEventHub(),
      pending,
      access: {
        allowedOrigins: allowedOrigins(8888),
        requiresToken: () => false,
        expectedToken: () => '',
      },
      actions: [truncatedAction],
    });
    await app.ready();
    const called = app.inject({
      method: 'POST',
      url: '/api/agent/actions/huge_edit',
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input: {} },
    });
    let card: PanelPendingAction | undefined;
    for (let attempt = 0; attempt < 200 && !card; attempt += 1) {
      card = pending.list()[0];
      if (!card) await new Promise((done) => setTimeout(done, 5));
    }
    expect(card?.preview.truncated).toBe(true);
    const approve = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card!.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toMatchObject({ error: 'preview_truncated' });
    expect(pending.list()).toHaveLength(1);
    const reject = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card!.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'reject' },
    });
    expect(reject.statusCode).toBe(200);
    expect((await called).json<PanelActionResult>().outcome).toBe('rejected');
    expect(executed).toBe(0);
  });

  it('цель не менялась — выполняется; изменилась или пропала — stale_preview без исполнения', async () => {
    expect(await run()).toMatchObject({ outcome: 'done' });
    expect(executed).toBe(1);
    expect(await run('v2')).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
    expect(await run('gone')).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
    expect(executed).toBe(1);
    const lines = readFileSync(agentJournalPath(appData), 'utf8').trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as PanelActionJournalEntry).messageCode)).toEqual([
      undefined,
      'stale_preview',
      'stale_preview',
    ]);
  });

  it('каждое изменение с предпросмотром состояния объявляет отпечаток (или названо, почему нет)', () => {
    // create_project: карточка — чистая функция входа (путь и имя), состояния в ней нет;
    // занятый путь маршрут отвергнет сам (409).
    const withoutState = new Set(['create_project']);
    const missing = PANEL_ACTIONS.filter(
      (action) => action.risk !== 'read' && !action.fingerprint && !withoutState.has(action.name),
    ).map((action) => action.name);
    expect(missing).toEqual([]);
  });
});
