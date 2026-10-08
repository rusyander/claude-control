import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Platform } from '@agentdeck/contracts';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import type {
  PanelActionResult,
  PanelActionsList,
  PanelPendingAction,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { registerAccessGate } from '../../../lib/access-gate/access-gate.ts';
import { registerEmptyBodyGuard } from '../../../lib/empty-body.ts';
import { createEventHub } from '../../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../../lib/origin-guard/origin-guard.ts';
import { PlatformGateway } from '../../../domains/platform/gateway/listener/listener.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import { agentJournalPath } from '../../../domains/panel-agent/journal/journal.ts';
import { registerPlatformRoutes } from '../../platform-routes/platform-routes.ts';
import { registerPanelAgentRoutes } from '../panel-agent-routes/panel-agent-routes.ts';

/**
 * Агенты и эмбеддинги контура (P3) на настоящих маршрутах контура и НАСТОЯЩЕМ
 * upstream — `tools/qa/stub-platform.mjs`, том же стабе, что у свипов провода.
 * Доказательство — след вызовов стаба (что ушло наверх и с каким ключом) и
 * память его сессий, а не текст ответа действия. Ключ вводит «человек»
 * маршрутом мастера; в ответах действий и в следе его нет.
 */
const ORIGIN = 'http://localhost:8888';
const KEY = 'CONTOUR-KEY-U5C-Zq9X';

interface StubCall {
  method: string;
  path: string;
  search: string;
  authorization?: string;
  body: string;
}
interface Stub {
  url: string;
  calls: StubCall[];
  close: () => Promise<void>;
}
type StartStub = (options: { port: number }) => Promise<Stub>;

// Путь не литералом: стаб — `.mjs` без типов, его форма описана здесь.
const STUB_MODULE = pathToFileURL(
  resolve(import.meta.dirname, '../../../../../../tools/qa/stub-platform.mjs'),
).href;

const platformOf = (id: string, driver: Platform['driver'], baseUrl: string): Platform => ({
  id,
  title: `Company ${id}`,
  driver,
  baseUrl,
  enabled: true,
  mode: 'required',
  budgetUsd: 100,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [{ id: 'agent-legal', title: 'Юрист' }],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
});

describe('panel-agent actions: contour agents and embeddings', () => {
  let root: string;
  let appData: string;
  let pending: PanelPendingActions;
  let gateway: PlatformGateway;
  let app: FastifyInstance;
  let stub: Stub;
  const results: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-u5c-contour-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const store = new AppStore(appData);
    store.updateSettings({ platformGateway: { ...store.getSettings().platformGateway, port: 0 } });
    const { startStubPlatform } = (await import(STUB_MODULE)) as { startStubPlatform: StartStub };
    stub = await startStubPlatform({ port: 0 });
    results.length = 0;

    pending = new PanelPendingActions(10_000);
    gateway = new PlatformGateway();
    const ctx = {
      store,
      backupDir: join(root, 'backups'),
      location: { paths: { root, appData, settings: join(root, 'settings.json') } },
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerPlatformRoutes(app, ctx, gateway);
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();

    // Человек заводит оба контура в мастере и вводит ключ: маршрут окна, Origin окна.
    for (const platform of [
      platformOf('corp', 'enterprise-platform', `${stub.url}/v1`),
      platformOf('plain', 'openai-compat', `${stub.url}/v1`),
    ]) {
      const saved = await app.inject({
        method: 'PUT',
        url: `/api/platforms/${platform.id}`,
        headers: { origin: ORIGIN },
        payload: { settings: platform, token: KEY },
      });
      expect(saved.statusCode, saved.body).toBe(200);
    }
    // Агенты и эмбеддинги ходят только через АКТИВНЫЙ контур — его включает человек.
    const activated = await app.inject({
      method: 'POST',
      url: '/api/platforms/corp/activate',
      headers: { origin: ORIGIN },
    });
    expect(activated.statusCode, activated.body).toBe(200);
    stub.calls.length = 0;
  });

  afterEach(async () => {
    pending.cancelAll();
    await gateway.stop();
    await app.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  const call = async (name: string, input: unknown): Promise<PanelActionResult> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input },
    });
    expect(res.statusCode).toBe(200);
    results.push(res.body);
    return res.json<PanelActionResult>();
  };

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const list = (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json<
        PanelPendingAction[]
      >();
      if (list[0]) return list[0];
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const decided = async (name: string, input: unknown, decision: 'approve' | 'reject') => {
    const result = call(name, input);
    const card = await waitPending();
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision },
    });
    expect(res.statusCode).toBe(200);
    return { card, result: await result };
  };

  const upstream = (suffix: string) => stub.calls.filter((item) => item.path.endsWith(suffix));

  it('действия в разделе «Контур» с заявленным риском; в схемах входа нет слов о ключе', async () => {
    const { actions } = (
      await app.inject({ method: 'GET', url: '/api/agent/actions' })
    ).json<PanelActionsList>();
    const mine = actions.filter((action) =>
      [
        'ask_contour_agent',
        'read_contour_agent_session',
        'reset_contour_agent_session',
        'contour_embeddings',
      ].includes(action.name),
    );
    expect(mine.map((action) => [action.name, action.section, action.risk])).toEqual([
      ['ask_contour_agent', 'contour', 'danger'],
      ['read_contour_agent_session', 'contour', 'read'],
      ['reset_contour_agent_session', 'contour', 'danger'],
      ['contour_embeddings', 'contour', 'change'],
    ]);
    expect(JSON.stringify(mine.map((action) => action.inputSchema))).not.toMatch(
      /token|key|secret|password/i,
    );
  });

  it('ask_contour_agent: отклонено — наверх ни шагу; одобрено — вопрос ушёл агенту с ключом, ответ без ключа', async () => {
    const input = {
      contour: 'corp',
      agent: 'agent-legal',
      message: 'Проверь договор',
      session: 's-1',
    };
    const rejected = await decided('ask_contour_agent', input, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(upstream('/agent/completions')).toEqual([]);

    const { card, result } = await decided('ask_contour_agent', input, 'approve');
    expect(card.risk).toBe('danger');
    expect(card.preview.summaryCode).toBe('summary-ask-contour-agent');
    const fields = Object.fromEntries(card.preview.fields.map((f) => [f.labelCode, f.value]));
    expect(fields['label-contour-agent']).toBe('Юрист (agent-legal)');
    expect(fields['label-contour-question']).toBe('Проверь договор');
    expect(fields['label-contour-session']).toBe('s-1');

    expect(result).toMatchObject({
      outcome: 'done',
      result: {
        outcome: 'ok',
        agentId: 'agent-legal',
        text: 'agent-legal: Проверь договор',
        sessionRecorded: true,
      },
    });
    const sent = upstream('/agent/completions');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({
      agent: 'agent-legal',
      messages: [{ role: 'user', content: 'Проверь договор' }],
      session: 's-1',
    });
    for (const text of [...results, readFileSync(agentJournalPath(appData), 'utf8')]) {
      expect(text).not.toContain(KEY);
    }
  });

  it('сессия: чтение показывает память контура; сброс одобрен — контур забыл, чтение пустое', async () => {
    await decided(
      'ask_contour_agent',
      { contour: 'corp', agent: 'agent-legal', message: 'Первый вопрос', session: 's-2' },
      'approve',
    );
    const read = await call('read_contour_agent_session', { contour: 'corp', session: 's-2' });
    expect(read).toMatchObject({
      outcome: 'done',
      result: { sessionId: 's-2', agentIds: ['agent-legal'], total: 2, empty: false },
    });
    expect((read.result as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'Первый вопрос' },
      { role: 'assistant', content: 'agent-legal: Первый вопрос' },
    ]);

    const kept = await decided(
      'reset_contour_agent_session',
      { contour: 'corp', session: 's-2' },
      'reject',
    );
    expect(kept.result.outcome).toBe('rejected');
    expect(stub.calls.filter((item) => item.method === 'DELETE')).toEqual([]);

    const { card, result } = await decided(
      'reset_contour_agent_session',
      { contour: 'corp', session: 's-2' },
      'approve',
    );
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({ valueCode: 'value-contour-session-forget' }),
    );
    expect(result).toMatchObject({ outcome: 'done', result: { reset: 's-2' } });
    expect(stub.calls.filter((item) => item.method === 'DELETE')).toHaveLength(1);
    const after = await call('read_contour_agent_session', { contour: 'corp', session: 's-2' });
    expect(after).toMatchObject({ outcome: 'done', result: { total: 0, empty: true } });
  });

  it('contour_embeddings: одобрено — векторы посчитаны контуром, агенту только число и размер', async () => {
    const { card, result } = await decided(
      'contour_embeddings',
      { contour: 'corp', model: 'ru-embed-v2', texts: ['первый', 'второй текст'] },
      'approve',
    );
    expect(card.risk).toBe('change');
    expect(card.preview.summaryCode).toBe('summary-contour-embeddings');
    expect(result).toMatchObject({
      outcome: 'done',
      result: { model: 'ru-embed-v2', vectors: 2, dimensions: 8, promptTokens: 6, totalTokens: 6 },
    });
    // Числа векторов модели не нужны и в ответ не попадают.
    expect(JSON.stringify(result.result)).not.toContain('[');
    const sent = upstream('/embeddings');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({
      model: 'ru-embed-v2',
      input: ['первый', 'второй текст'],
    });
  });

  it('отказы до карточки: у контура нет агентов, контура нет — наверх ни шагу', async () => {
    const noAgents = await call('ask_contour_agent', {
      contour: 'plain',
      agent: 'agent-legal',
      message: 'Привет',
    });
    expect(noAgents.outcome).toBe('failed');
    expect(noAgents.message).toMatch(/declares no published agents/);

    // Контур с ключом, но не активный: маршрут отказал бы 404 уже после одобрения.
    const inactive = await call('contour_embeddings', {
      contour: 'plain',
      model: 'ru-embed-v2',
      texts: ['текст'],
    });
    expect(inactive.outcome).toBe('failed');
    expect(inactive.message).toMatch(/is not the active one/);

    const missing = await call('read_contour_agent_session', { contour: 'ghost', session: 's-1' });
    expect(missing.outcome).toBe('failed');
    expect(missing.message).toMatch(/not found/);

    expect((await app.inject({ method: 'GET', url: '/api/agent/pending' })).json()).toEqual([]);
    expect(stub.calls).toEqual([]);
  });
});
