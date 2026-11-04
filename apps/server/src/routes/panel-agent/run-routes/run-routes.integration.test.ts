import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  PanelActionResult,
  PanelAgentConversation,
  PanelAgentRunEvent,
} from '@agentdeck/contracts/panel-agent';
import type { AskFields } from '@agentdeck/contracts/core/ask';
import { platformSchema } from '@agentdeck/contracts/platform';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { registerAccessGate } from '../../../lib/access-gate/access-gate.ts';
import {
  BRIDGE_TOKEN_HEADER,
  createBridgeTokenLedger,
  type BridgeTokenLedger,
} from '../../../lib/bridge-tokens/bridge-tokens.ts';
import { createEventHub } from '../../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../../lib/origin-guard/origin-guard.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import { buildManagedProfile } from '../../../domains/platform/apply/profile.ts';
import { writePlatform, writeToken } from '../../../domains/platform/store/store.ts';
import { createCoreAskPort } from '../../../domains/core-ask/core-ask.ts';
import {
  startFakeCore,
  type FakeCore,
  type FakeCoreTurn,
} from '../../../domains/core-ask/__fixtures__/fake-core.ts';
import { registerPanelAgentRoutes } from '../panel-agent-routes/panel-agent-routes.ts';
import { registerPanelAgentRunRoutes, type PanelAgentRunRouteDeps } from './run-routes.ts';

/**
 * Ход агента панели (этап 10, F2, проход 2c) — сессия ядра «ask». Ядро здесь — заглушка на
 * настоящем HTTP (`fake-core.ts`): клиент панели идёт своим путём (строка ядра, bearer, число
 * загрузки, SSE вида сеанса), а сценарий сессии зовёт панель ТЕМ ЖЕ путём, что мост `panel.mjs`:
 * `POST /api/agent/actions/:name` с токеном моста хода. Доказательство — поля вопроса, которые
 * получило ядро, кадры окна и ответы рубежа доступа, а не текст ответа.
 */
/** Собран из кусков: присваивание, похожее на ключ, в репозитории не лежит. */
const SECRET = ['contour', 'agent', 'key', '7d1e'].join('-');
/** Ключ формы вендора (`sk-…`) — его ловит встроенный образец `secret_key`. */
const PASTED_KEY = ['sk', 'ant', 'api03', 'Q7rT2xVb9LmN4pZs8KdW'].join('-');
const CONTOUR = 'agent-contour';
const GATEWAY_PORT = 45987;
const SELF = 'http://127.0.0.1:5211';
const REPLY = 'Вы в разделе проектов.';

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe('POST /api/agent/run — ход агента сессией ядра', () => {
  let appData: string;
  let store: AppStore;
  let app: FastifyInstance;
  let pending: PanelPendingActions;
  let bridges: BridgeTokenLedger;
  let core: FakeCore;
  /** Что делает сессия этого теста; по умолчанию — `standard`. */
  let behaviour: {
    slowMs?: number;
    slowAfterMs?: number;
    failAfter?: boolean;
    conversation?: string;
    extra?: (turn: FakeCoreTurn) => Promise<void>;
  };
  /** Ответы панели на вызовы моста за тест. */
  let bridgeAnswers: Array<{ status: number; body: string }>;

  const bridgeCall = async (fields: AskFields, name: string, conversation?: string) => {
    const answer = await app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [BRIDGE_TOKEN_HEADER]: fields.panelBridge!.token, 'x-agentdeck-agent': '1' },
      payload: { input: {}, conversationId: conversation ?? fields.panelBridge!.conversation },
    });
    bridgeAnswers.push({ status: answer.statusCode, body: answer.payload });
    return answer;
  };

  /** Сессия: вызов `where_am_i` мостом, ответ словами, конец хода. */
  const standard = async (turn: FakeCoreTurn): Promise<void> => {
    const { fields, emit, cancelled } = turn;
    const stop = cancelled.then(() => 'cancelled' as const);
    if (behaviour.slowMs && (await Promise.race([sleep(behaviour.slowMs), stop]))) return;
    if (behaviour.extra) return behaviour.extra(turn);
    emit({ kind: 'user-text', data: { text: fields.prompt } });
    emit({ kind: 'tool-call', data: { toolUseId: 't0', name: 'ToolSearch', input: {} } });
    emit({
      kind: 'tool-call',
      data: { toolUseId: 't1', name: 'mcp__panel-bridge__where_am_i', input: {} },
    });
    const answer = await bridgeCall(fields, 'where_am_i', behaviour.conversation);
    emit({ kind: 'tool-result', data: { toolUseId: 't1', isError: answer.statusCode !== 200 } });
    if (behaviour.slowAfterMs && (await Promise.race([sleep(behaviour.slowAfterMs), stop]))) {
      return;
    }
    if (behaviour.failAfter) {
      emit({ kind: 'error', data: { code: 'exit', detail: 'CLI exited with code 3' } });
      return;
    }
    emit({ kind: 'assistant-text', data: { text: REPLY } });
    emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
  };

  const buildApp = async (
    extra: Partial<PanelAgentRunRouteDeps> = {},
    panelToken?: string,
  ): Promise<FastifyInstance> => {
    const ctx = { store, location: { paths: { appData } } } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => panelToken !== undefined,
      expectedToken: () => panelToken ?? '',
      bridges,
    };
    pending = new PanelPendingActions(10_000);
    const instance = Fastify();
    registerAccessGate(instance, access);
    registerPanelAgentRoutes(instance, ctx, { hub: createEventHub(), pending, access, bridges });
    registerPanelAgentRunRoutes(instance, ctx, {
      selfBaseUrl: SELF,
      ask: createCoreAskPort(() => core.home, core.identity),
      bridges,
      pending,
      pollMs: 20,
      ...extra,
    });
    await instance.ready();
    return instance;
  };

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-run-appdata-'));
    store = new AppStore(appData);
    bridges = createBridgeTokenLedger();
    behaviour = {};
    bridgeAnswers = [];
    core = await startFakeCore({ turn: (turn) => standard(turn) });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    await core.close();
    rmSync(appData, { recursive: true, force: true });
  });

  const run = (body: object) =>
    app.inject({ method: 'POST', url: '/api/agent/run', payload: body });

  const framesOf = (payload: string): PanelAgentRunEvent[] =>
    payload
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as PanelAgentRunEvent);

  const lastAsk = (): AskFields => core.asks.at(-1)!;

  const contour = (contourPrompt = true): void => {
    const platform = platformSchema.parse({
      id: CONTOUR,
      title: 'Контур агента',
      driver: 'enterprise-platform',
      baseUrl: 'https://api.dev.example.ru',
      enabled: true,
      mode: 'required',
      consumers: ['assistant'],
      contourPrompt,
    });
    writePlatform(store, platform);
    writeToken(appData, CONTOUR, SECRET);
    const profile = buildManagedProfile(
      platform,
      { enabled: true, port: GATEWAY_PORT, forceStream: true },
      'qwen2.5:7b',
    );
    store.updateSettings({
      activePlatformId: CONTOUR,
      endpointProfiles: [profile],
      assistantEndpointId: profile.id,
    });
  };

  const body = {
    conversationId: 'conv-1',
    messages: [{ role: 'user', content: 'Где я? "кавычки" & | > и\nвторая строка' }],
    context: { route: '/projects', title: 'Проекты', projectPath: 'C:\\work\\demo' },
  };

  it('ход — вопрос ядру: только мост панели с токеном хода, бриф системой, реплика дословно', async () => {
    const response = await run(body);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const frames = framesOf(response.payload);
    expect(frames[0]).toEqual({ kind: 'start', conversationId: 'conv-1', providerId: 'claude' });
    // Поиск инструментов — служба CLI, в ленту не идёт.
    expect(frames.filter((f) => f.kind === 'tool')).toEqual([{ kind: 'tool', name: 'where_am_i' }]);
    expect(frames).toContainEqual({ kind: 'tool-result', name: 'where_am_i', isError: false });
    expect(frames).toContainEqual({ kind: 'text', text: REPLY });
    expect(frames.at(-1)).toEqual({ kind: 'done', reply: REPLY });

    expect(core.asks).toHaveLength(1);
    const fields = lastAsk();
    expect(fields.tools).toBe('panel-bridge');
    expect(fields.panelBridge).toMatchObject({ url: SELF, conversation: 'conv-1' });
    expect(fields.panelBridge!.token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(fields).toMatchObject({ adapter: 'claude', consumer: 'assistant' });
    expect(fields.routes).toBeUndefined();
    // Текст человека — дословно, с кавычками и переводом строки.
    expect(fields.prompt).toBe(body.messages[0]!.content);
    expect(fields.system).toContain('route /projects');
    expect(fields.system).toContain('C:\\work\\demo');
    expect(fields.system).toContain('"panel-bridge" MCP server');
    // Доказательство человека — число загрузки ядра, по одному на просьбу.
    expect(core.nonces).toEqual({ minted: 1, used: 1 });

    // Мост дошёл до панели своим токеном; после хода токен мёртв.
    expect(bridgeAnswers).toEqual([expect.objectContaining({ status: 200 })]);
    expect(bridges.size()).toBe(0);
    const late = await bridgeCall(fields, 'where_am_i');
    expect(late.statusCode).toBe(401);

    const saved = await app.inject({ method: 'GET', url: '/api/agent/conversations/conv-1' });
    const conversation = saved.json<PanelAgentConversation>();
    expect(conversation.context.route).toBe('/projects');
    expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(conversation.messages[1]!.content).toBe(REPLY);
    const list = await app.inject({ method: 'GET', url: '/api/agent/conversations' });
    expect(list.json()).toEqual([expect.objectContaining({ id: 'conv-1', messages: 2 })]);
  });

  it('следующий ход разговора знает итоги действий прошлого хода; другой разговор — нет', async () => {
    expect((await run({ ...body, conversationId: 'conv-mem' })).statusCode).toBe(200);
    expect(lastAsk().prompt).toBe(body.messages[0]!.content);

    const next = await run({
      ...body,
      conversationId: 'conv-mem',
      messages: [
        ...body.messages,
        { role: 'assistant', content: REPLY },
        { role: 'user', content: 'Открой тот чат' },
      ],
    });
    expect(next.statusCode).toBe(200);
    // Итог действия — из ответа панели мосту: имя и начало результата.
    expect(lastAsk().prompt).toContain('where_am_i: ');
    expect(lastAsk().prompt).toContain('"route":"/projects"');

    expect((await run({ ...body, conversationId: 'conv-other' })).statusCode).toBe(200);
    expect(lastAsk().prompt).toBe(body.messages[0]!.content);
  });

  it('токен моста — только своего разговора, только действия агента и только живой', async () => {
    behaviour.conversation = 'conv-foreign';
    const response = await run(body);
    expect(response.statusCode).toBe(200);
    // Вызов от имени чужого разговора — отказ до действия, модель видит провал.
    expect(bridgeAnswers[0]!.status).toBe(403);
    expect(framesOf(response.payload)).toContainEqual({
      kind: 'tool-result',
      name: 'where_am_i',
      isError: true,
    });

    const token = bridges.mint('conv-x');
    const elsewhere = await app.inject({
      method: 'GET',
      url: '/api/agent/conversations',
      headers: { [BRIDGE_TOKEN_HEADER]: token },
    });
    expect(elsewhere.statusCode).toBe(401);
    const forged = await app.inject({
      method: 'GET',
      url: '/api/agent/actions',
      headers: { [BRIDGE_TOKEN_HEADER]: 'x'.repeat(43) },
    });
    expect(forged.statusCode).toBe(401);
    const live = await app.inject({
      method: 'GET',
      url: '/api/agent/actions',
      headers: { [BRIDGE_TOKEN_HEADER]: token },
    });
    expect(live.statusCode).toBe(200);
    bridges.revoke(token);
    const dead = await app.inject({
      method: 'GET',
      url: '/api/agent/actions',
      headers: { [BRIDGE_TOKEN_HEADER]: token },
    });
    expect(dead.statusCode).toBe(401);
  });

  it('удалённый доступ включён: мост входит токеном хода, токена панели ядро не получает', async () => {
    const PANEL_TOKEN = 'planted-remote-token-' + 'x'.repeat(24);
    await app.close();
    app = await buildApp({}, PANEL_TOKEN);
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/run',
      headers: { authorization: `Bearer ${PANEL_TOKEN}` },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(framesOf(response.payload).at(-1)).toEqual({ kind: 'done', reply: REPLY });
    expect(bridgeAnswers[0]!.status).toBe(200);
    expect(JSON.stringify(core.asks)).not.toContain(PANEL_TOKEN);
  });

  it('потолок хода стоит, пока карточка разговора ждёт клика; без карточки — ход снят и ядру сказано cancel', async () => {
    await app.close();
    app = await buildApp({ timeoutMs: 300, ceilingTickMs: 50 });
    behaviour.slowMs = 1500;

    const card = pending.create({
      name: 'save_rule',
      risk: 'change',
      conversationId: 'conv-1',
      preview: { summary: 'x', fields: [] },
    });
    const waited = await run(body);
    pending.cancel(card.pending.id);
    expect(framesOf(waited.payload).at(-1)).toEqual({ kind: 'done', reply: REPLY });
    expect(core.cancels).toEqual([]);

    const other = pending.create({
      name: 'save_rule',
      risk: 'change',
      conversationId: 'conv-other',
      preview: { summary: 'x', fields: [] },
    });
    const killed = await run({ ...body, conversationId: 'conv-ceiling' });
    pending.cancel(other.pending.id);
    expect(framesOf(killed.payload).at(-1)).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(framesOf(killed.payload).at(-1))).toContain('отведённое время');
    expect(core.cancels).toHaveLength(1);
    expect(bridges.size()).toBe(0);
  });

  it('разговор удаляется из истории; идущий — нет; чужой или кривой id — 404', async () => {
    expect((await run({ ...body, conversationId: 'conv-del' })).statusCode).toBe(200);
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/agent/conversations/conv-del',
    });
    expect(removed.statusCode).toBe(200);
    const gone = await app.inject({ method: 'GET', url: '/api/agent/conversations/conv-del' });
    expect(gone.statusCode).toBe(404);
    const again = await app.inject({ method: 'DELETE', url: '/api/agent/conversations/conv-del' });
    expect(again.statusCode).toBe(404);
    const crooked = await app.inject({ method: 'DELETE', url: '/api/agent/conversations/..%2Fx' });
    expect(crooked.statusCode).toBe(404);

    behaviour.slowMs = 1200;
    const running = run({ ...body, conversationId: 'conv-busy' });
    await sleep(300);
    const busy = await app.inject({ method: 'DELETE', url: '/api/agent/conversations/conv-busy' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ messageCode: 'panel-conversation-running' });
    await running;
    const after = await app.inject({ method: 'DELETE', url: '/api/agent/conversations/conv-busy' });
    expect(after.statusCode).toBe(200);
  });

  const conversationFile = (id: string) => join(appData, 'panel-agent', `${id}.json`);
  const stored = (id: string): PanelAgentConversation =>
    JSON.parse(readFileSync(conversationFile(id), 'utf8')) as PanelAgentConversation;

  it('сделанное пишется в файл по ходу, а не только в конце', async () => {
    behaviour.slowAfterMs = 1500;
    const running = run(body);
    let during: PanelAgentConversation | undefined;
    for (let attempt = 0; attempt < 100 && !during?.openTurn?.actions.length; attempt += 1) {
      await sleep(20);
      if (existsSync(conversationFile('conv-1'))) during = stored('conv-1');
    }
    expect(during?.openTurn).toMatchObject({ actions: ['where_am_i'], texts: [] });
    expect(during?.messages.map((message) => message.role)).toEqual(['user']);
    await running;
    const after = stored('conv-1');
    expect(after.openTurn).toBeUndefined();
    expect(after.messages.map((message) => message.content)).toEqual([
      body.messages[0]!.content,
      REPLY,
    ]);
  });

  it('сессия упала после действия — сделанное запечатано, и следующий ход его видит', async () => {
    behaviour.failAfter = true;
    const failed = await run(body);
    expect(framesOf(failed.payload).at(-1)).toMatchObject({
      kind: 'error',
      message: 'CLI exited with code 3',
    });
    const sealedTurn = stored('conv-1');
    expect(sealedTurn.openTurn).toBeUndefined();
    expect(sealedTurn.messages[1]).toMatchObject({ role: 'assistant', interrupted: true });
    expect(sealedTurn.messages[1]!.content).toContain('Actions performed: where_am_i.');
    expect(sealedTurn.messages[1]!.content).toContain('The answer was not finished:');
    expect(sealedTurn.messages[1]!.content).not.toMatch(/[А-Яа-яЁё]/);
    expect(sealedTurn.messages[1]!.seal).toMatchObject({
      reason: 'failed',
      actions: ['where_am_i'],
    });

    behaviour.failAfter = false;
    const next = await run({ ...body, messages: [{ role: 'user', content: 'продолжай' }] });
    expect(framesOf(next.payload).at(-1)).toMatchObject({ kind: 'done' });
    expect(lastAsk().prompt).toContain('Actions performed: where_am_i.');
    expect(stored('conv-1').messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('ход прежнего процесса панели запечатывается при чтении: перезапуск его не стирает', async () => {
    const at = new Date().toISOString();
    mkdirSync(join(appData, 'panel-agent'), { recursive: true });
    writeFileSync(
      join(appData, 'panel-agent', 'conv-restart.json'),
      JSON.stringify({
        id: 'conv-restart',
        createdAt: at,
        updatedAt: at,
        context: body.context,
        messages: [{ role: 'user', content: 'выключи правило', at }],
        openTurn: {
          boot: 'previous-process',
          startedAt: at,
          texts: ['Выключаю.'],
          actions: ['toggle_rule'],
        },
      }),
    );
    const read = await app.inject({ method: 'GET', url: '/api/agent/conversations/conv-restart' });
    const conversation = read.json<PanelAgentConversation>();
    expect(conversation.openTurn).toBeUndefined();
    expect(conversation.messages[1]!.content).toBe(
      'Выключаю.\n\nActions performed: toggle_rule.\n\nThe answer was not finished: the panel restarted mid-turn.',
    );
    expect(conversation.messages[1]!.seal).toEqual({ reason: 'restart', actions: ['toggle_rule'] });
    expect(stored('conv-restart').messages).toHaveLength(2);
  });

  it('отставшая вкладка не затирает ход другой вкладки: отказ conversation_stale, файл цел', async () => {
    expect((await run({ ...body, conversationId: 'conv-tabs' })).statusCode).toBe(200);
    const reply = stored('conv-tabs').messages[1]!.content;
    const alpha = [...body.messages, { role: 'assistant', content: reply }];
    const beta = await run({
      ...body,
      conversationId: 'conv-tabs',
      messages: [...alpha, { role: 'user', content: 'бета' }],
    });
    expect(beta.statusCode).toBe(200);
    const gamma = await run({
      ...body,
      conversationId: 'conv-tabs',
      messages: [...alpha, { role: 'user', content: 'гамма' }],
    });
    expect(gamma.statusCode).toBe(409);
    expect(gamma.json()).toMatchObject({ error: 'conversation_stale' });
    expect(stored('conv-tabs').messages.map((m) => m.content)).not.toContain('гамма');
    expect(core.asks).toHaveLength(2);
  });

  it('[Z5-9] удалённый в другой вкладке разговор не воскресает: отказ conversation_deleted', async () => {
    expect((await run({ ...body, conversationId: 'conv-gone' })).statusCode).toBe(200);
    const history = stored('conv-gone').messages.map(({ role, content }) => ({ role, content }));
    await app.inject({ method: 'DELETE', url: '/api/agent/conversations/conv-gone' });
    const late = await run({
      ...body,
      conversationId: 'conv-gone',
      messages: [...history, { role: 'user', content: 'ещё вопрос' }],
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: 'conversation_deleted' });
    expect(existsSync(conversationFile('conv-gone'))).toBe(false);
  });

  it('where_am_i отвечает страницей хода этого разговора', async () => {
    await run(body);
    const answer = await app.inject({
      method: 'POST',
      url: '/api/agent/actions/where_am_i',
      payload: { input: {}, conversationId: 'conv-1' },
    });
    expect(answer.json<PanelActionResult>().result).toEqual({
      known: true,
      route: '/projects',
      title: 'Проекты',
      projectPath: 'C:\\work\\demo',
      section: 'Projects',
    });
  });

  it('через контур: маршрут gateway контура и модель профиля, промпт контура перед брифом, ключа нет нигде', async () => {
    contour();
    const response = await run(body);
    expect(response.statusCode).toBe(200);
    expect(framesOf(response.payload)[0]).toMatchObject({ kind: 'start', contourId: CONTOUR });
    const fields = lastAsk();
    expect(fields.routes).toEqual([
      {
        adapter: 'claude',
        route: { kind: 'gateway', id: `gateway:${CONTOUR}` },
        modelPattern: '*',
      },
    ]);
    expect(fields.model).toBe('qwen2.5:7b');
    expect(fields.system).toContain('«Контур агента»');
    expect(fields.system!.indexOf('«Контур агента»')).toBeLessThan(
      fields.system!.indexOf('route /projects'),
    );
    expect(JSON.stringify(core.asks)).not.toContain(SECRET);
    expect(response.payload).not.toContain(SECRET);
  });

  it('через контур со снятым промптом контура — только бриф агента', async () => {
    contour(false);
    expect((await run(body)).statusCode).toBe(200);
    expect(lastAsk().routes?.[0]?.route.id).toBe(`gateway:${CONTOUR}`);
    expect(lastAsk().system).not.toContain('«Контур агента»');
    expect(lastAsk().system).toContain('route /projects');
  });

  it('свой эндпоинт ассистента — маршрут ключа своего адреса; ключ держит ядро, не процесс', async () => {
    store.updateSettings({
      endpointProfiles: [
        {
          id: 'own',
          name: 'Свой шлюз',
          baseUrl: 'http://127.0.0.1:9',
          apiKind: 'anthropic',
          model: '',
          writeToken: false,
          imagesUrl: '',
          ownerPlatformId: '',
        },
      ],
      assistantEndpointId: 'own',
    });
    expect((await run(body)).statusCode).toBe(200);
    expect(lastAsk().routes).toEqual([
      {
        adapter: 'claude',
        route: { kind: 'api-key', id: 'api-key:endpoint:own' },
        modelPattern: '*',
      },
    ]);
    expect(lastAsk().model).toBeUndefined();
  });

  it('ключ в сообщении маскируется до ядра и до файла разговора', async () => {
    const secretBody = {
      ...body,
      messages: [
        { role: 'user', content: `подключи контур, вот ключ ${PASTED_KEY}` },
        { role: 'assistant', content: 'Ключ в чат не нужен.' },
        { role: 'user', content: `всё-таки возьми ${PASTED_KEY} и сохрани` },
      ],
    };
    expect((await run({ ...body, messages: secretBody.messages.slice(0, 1) })).statusCode).toBe(
      200,
    );
    const response = await run(secretBody);
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(core.asks)).not.toContain(PASTED_KEY);
    expect(lastAsk().prompt.match(/\[КЛЮЧ_1\]/g)).toHaveLength(2);
    expect(lastAsk().prompt).toContain('подключи контур, вот ключ [КЛЮЧ_1]');
    const saved = readFileSync(conversationFile('conv-1'), 'utf8');
    expect(saved).not.toContain(PASTED_KEY);
    expect(response.payload).not.toContain(PASTED_KEY);
  });

  it('без своих правил ссылка, адрес, почта и id доходят до ядра; ключи и доступ в адресе — нет (D1)', async () => {
    const content =
      'подключи контур, вот ссылка http://127.0.0.1:5222 и https://gw.example.com/v1, ' +
      'хост 10.0.0.7, почта qa@example.com, кейс 3f2c9a1e-8b7d-4c6e-9a01-5d4e3c2b1a09, ' +
      `ключ ${PASTED_KEY}, доступ https://bob:pa55word@git.example.com/repo.git`;
    expect((await run({ ...body, messages: [{ role: 'user', content }] })).statusCode).toBe(200);
    const prompt = lastAsk().prompt;
    expect(prompt).toContain('вот ссылка http://127.0.0.1:5222 и https://gw.example.com/v1');
    expect(prompt).toContain('хост 10.0.0.7, почта qa@example.com');
    expect(prompt).toContain('кейс 3f2c9a1e-8b7d-4c6e-9a01-5d4e3c2b1a09');
    expect(prompt).not.toContain(PASTED_KEY);
    expect(prompt).not.toContain('pa55word');
  });

  it('ключ маскируется и поверх своих правил раздела, где образца ключей нет', async () => {
    writeFileSync(
      join(appData, 'dlp-rules.json'),
      JSON.stringify({
        rules: [
          {
            id: 'own-name',
            name: 'Фамилия',
            enabled: true,
            kind: 'terms',
            terms: ['Иванов'],
            pattern: '',
            action: 'mask',
            label: 'ИМЯ',
          },
        ],
      }),
    );
    const response = await run({
      ...body,
      messages: [{ role: 'user', content: `Иванов прислал ${PASTED_KEY}` }],
    });
    expect(response.statusCode).toBe(200);
    expect(lastAsk().prompt).toBe('[ИМЯ_1] прислал [КЛЮЧ_1]');
  });

  it('битые правила защиты данных — отказ data_mask_broken, ядро не спрошено', async () => {
    writeFileSync(join(appData, 'dlp-rules.json'), '{ не json');
    const response = await run(body);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'data_mask_broken' });
    expect(core.asks).toEqual([]);
    expect(core.nonces.minted).toBe(0);
    expect(existsSync(conversationFile('conv-1'))).toBe(false);
  });

  it('ядро отказало (суд маршрута) — ошибка хода словами ядра, токен снят', async () => {
    await app.close();
    await core.close();
    core = await startFakeCore({
      refuse: {
        status: 422,
        code: 'ask-refused',
        error: 'ask refused',
        problems: ['adapter aider: not in the allowed routes'],
      },
    });
    app = await buildApp();
    store.updateSettings({ provider: 'aider' });
    const response = await run(body);
    expect(response.statusCode).toBe(200);
    const last = framesOf(response.payload).at(-1);
    expect(last).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(last)).toContain('adapter aider: not in the allowed routes');
    expect(lastAsk().adapter).toBe('aider');
    expect(bridges.size()).toBe(0);
    // Ход без сделанного запечатан без следа: открытого хода в файле нет.
    expect(stored('conv-1').openTurn).toBeUndefined();
  });

  it('ядро не запущено — ошибка хода с причиной, а не тишина', async () => {
    await app.close();
    const empty = mkdtempSync(join(tmpdir(), 'cc-agent-no-core-'));
    app = await buildApp({ ask: createCoreAskPort(() => empty, core.identity) });
    try {
      const response = await run(body);
      expect(response.statusCode).toBe(200);
      const last = framesOf(response.payload).at(-1);
      expect(last).toMatchObject({ kind: 'error' });
      expect(JSON.stringify(last)).toContain('core is not running');
      expect(bridges.size()).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('вызов инструмента не моста в сессии — ход оборван, ядру cancel, текст про лишние руки', async () => {
    behaviour.extra = async ({ emit, cancelled }) => {
      emit({
        kind: 'tool-call',
        data: { toolUseId: 'b1', name: 'Bash', input: { command: 'dir' } },
      });
      await cancelled;
    };
    const response = await run(body);
    const frames = framesOf(response.payload);
    expect(frames.filter((f) => f.kind === 'tool')).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(frames.at(-1))).toContain('Bash');
    expect(core.cancels).toHaveLength(1);
    expect(stored('conv-1').openTurn).toBeUndefined();
    expect(bridges.size()).toBe(0);
  });

  it('рабочая заметка латиницей перед действием в русском разговоре в ленту не идёт; последний текст — идёт', async () => {
    behaviour.extra = async ({ fields, emit }) => {
      emit({ kind: 'assistant-text', data: { text: 'Need the page first; ' } });
      emit({ kind: 'assistant-text', data: { text: 'calling where_am_i.' } });
      emit({
        kind: 'tool-call',
        data: { toolUseId: 't1', name: 'mcp__panel-bridge__where_am_i', input: {} },
      });
      await bridgeCall(fields, 'where_am_i');
      emit({ kind: 'tool-result', data: { toolUseId: 't1', isError: false } });
      emit({ kind: 'assistant-text', data: { text: 'You are on the projects page.' } });
      emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
    };
    const response = await run(body);
    const frames = framesOf(response.payload);
    expect(frames.filter((f) => f.kind === 'text')).toEqual([
      { kind: 'text', text: 'You are on the projects page.' },
    ]);
    expect(frames.at(-1)).toEqual({ kind: 'done', reply: 'You are on the projects page.' });
  });

  it('неверное тело — 400: последняя реплика не человека, id с метасимволами', async () => {
    const assistantLast = await run({
      ...body,
      messages: [{ role: 'assistant', content: 'привет' }],
    });
    expect(assistantLast.statusCode).toBe(400);
    const badId = await run({ ...body, conversationId: 'a&calc' });
    expect(badId.statusCode).toBe(400);
    expect(badId.json()).toMatchObject({ error: 'invalid_body' });
    expect(core.asks).toEqual([]);
  });

  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('картинка реплики едет в вопрос ядру как есть: имя, тип, base64', async () => {
    const before = core.asks.length;
    const response = await run({
      ...body,
      messages: [{ role: 'user', content: 'Что на снимке?\n\nAttached images: shot.png' }],
      images: [{ name: 'shot.png', mediaType: 'image/png', base64: PNG }],
    });
    expect(response.statusCode).toBe(200);
    expect(core.asks.length).toBe(before + 1);
    expect(core.asks.at(-1)?.images).toEqual([
      { name: 'shot.png', mediaType: 'image/png', base64: PNG },
    ]);
  });

  it('не картинка под видом PNG — 400 с именем файла, ядро не спрошено', async () => {
    const response = await run({
      ...body,
      images: [
        {
          name: 'note.png',
          mediaType: 'image/png',
          base64: Buffer.from('просто текст, не картинка').toString('base64'),
        },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_images',
      messageCode: 'media-agent-image-not-image',
      params: { name: 'note.png' },
    });
    expect(core.asks).toEqual([]);
  });
});
