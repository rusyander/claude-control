import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { SPLIT_BLOCK_LANG, type TaskSplitResult } from '@agentdeck/contracts/task-split';
import { SPLIT_PLAN_BLOCK_LANG } from '@agentdeck/contracts/split-plan';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { sandboxRoot } from '../../domains/chat/ChatArtifacts.ts';
import { SplitConveyor } from '../../domains/chat/split-conveyor.ts';
import { TreePause } from '../../domains/chat/tree-pause.ts';
import { describeIdle } from '../../domains/groups/describe.ts';
import { ProviderChatService } from '../../domains/provider-chat.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { registerConfigRoutes } from '../config-routes.ts';
import { registerGroupRoutes } from '../group-routes.ts';
import { registerChatRoutes } from '../chat-routes.ts';
import { registerChatSplitRoutes } from '../chat/split-routes.ts';
import { pauseOnHumanStop } from '../chat/split-control-routes.ts';
import { registerChatTreeRoutes } from '../chat/tree-routes.ts';
import { registerChatGroupSettingsRoutes } from '../chat/group-settings-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Действия агента над чатами (U1) на настоящих маршрутах панели: список чатов
 * и лента из транскриптов на диске, реестр прогонов, разделение с конвейером,
 * пауза дерева, группа чата. Подменён только процесс CLI (фабрика прогонов
 * реестра) и заведение копий git у групп разделения. Доказательство — что
 * дошло до процесса (промпт, сессия, модель), реестр прогонов и хранилище, а не
 * текст ответа действия.
 */
const ORIGIN = 'http://localhost:8888';
/** Метка промпта, на которой фальшивый прогон держит ход до остановки. */
const HOLD = 'ДЕРЖАТЬ-ХОД';
const SECRET = `ghp_${'A1b2C3d4'.repeat(4)}`;

interface Started {
  key: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  effort?: string;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('panel-agent actions: chats', () => {
  let root: string;
  let appData: string;
  let projectDir: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let conveyor: SplitConveyor;
  let pending: PanelPendingActions;
  let app: FastifyInstance;
  let started: Started[];
  let resumed: number[];
  /** Режим прав каждого запущенного хода — чем CLI на деле разрешено править. */
  let modes: Array<string | undefined>;
  /** Потолок параллельных групп конвейера; тест сверх потолка опускает его. */
  let ceiling: number;
  /** Что действия отправили в маршруты продолжения — тело целиком. */
  let outgoing: Array<{ url: string; body: unknown }>;
  const ids = {
    main: randomUUID(),
    other: randomUUID(),
    twinA: randomUUID(),
    twinB: randomUUID(),
    sandbox: randomUUID(),
    parent: randomUUID(),
  };

  const now = () => new Date().toISOString();
  const userLine = (id: string, cwd: string, text: string, uuid = randomUUID()) =>
    JSON.stringify({
      type: 'user',
      uuid,
      sessionId: id,
      cwd,
      timestamp: now(),
      message: { role: 'user', content: text },
    });
  const assistantLine = (id: string, cwd: string, content: unknown[]) =>
    JSON.stringify({
      type: 'assistant',
      uuid: randomUUID(),
      sessionId: id,
      cwd,
      timestamp: now(),
      message: { role: 'assistant', model: 'claude-test', content },
    });
  const seed = (id: string, _cwd: string, lines: string[]) => {
    const dir = join(root, 'projects', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  };
  const splitBlock = (groups: Array<{ title: string; branch: string; tasks: string[] }>) =>
    ['```' + SPLIT_BLOCK_LANG, JSON.stringify({ groups }), '```'].join('\n');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-u1-config-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'cc-agent-u1-project-'));
    started = [];
    modes = [];
    resumed = [];
    ceiling = 5;
    outgoing = [];

    // Главный чат: просьба с ключом, предложение разделения и открытый вопрос.
    seed(ids.main, projectDir, [
      userLine(ids.main, projectDir, `Сделай форму входа и тесты. Токен ${SECRET}`),
      assistantLine(ids.main, projectDir, [
        {
          type: 'text',
          text: `Предлагаю разделить.\n${splitBlock([
            { title: 'Форма входа', branch: 'feat/login', tasks: ['поля', 'валидация'] },
            { title: 'Тесты', branch: 'feat/tests', tasks: ['e2e входа'] },
          ])}`,
        },
        {
          type: 'tool_use',
          id: 'toolu_ask_1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Какие браузеры поддерживать?',
                header: 'Браузеры',
                options: [{ label: 'Все (Recommended)' }, { label: 'Только Chrome' }],
              },
            ],
          },
        },
      ]),
    ]);
    seed(ids.other, projectDir, [userLine(ids.other, projectDir, 'Почини сборку ракеты')]);
    seed(ids.twinA, projectDir, [userLine(ids.twinA, projectDir, 'Дубль')]);
    seed(ids.twinB, projectDir, [userLine(ids.twinB, projectDir, 'Дубль')]);
    const sandboxCwd = join(sandboxRoot(), ids.sandbox);
    seed(ids.sandbox, sandboxCwd, [userLine(ids.sandbox, sandboxCwd, 'Разговор в панели')]);
    seed(ids.parent, projectDir, [userLine(ids.parent, projectDir, 'Родитель разделения')]);

    store = new AppStore(appData);
    const paths = {
      root,
      appData,
      settings: join(root, 'settings.json'),
      settingsLocal: join(root, 'settings.local.json'),
      claudeMd: join(root, 'CLAUDE.md'),
      secretsEnv: join(root, '.mcp-secrets.env'),
      skills: join(root, 'skills'),
      hooks: join(root, 'hooks'),
      mcpConfig: join(root, '.claude.json'),
    };
    const ctx = {
      store,
      location: { paths },
      backupDir: join(appData, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };

    // Единственная подмена — процесс CLI. Ход с меткой держится до «Стоп».
    registry = new ChatRunRegistry((): RunLike => {
      let finish = (): void => undefined;
      return {
        start: (options: RunOptions, onEvent) => {
          const key = options.permissionPrompt?.runId ?? '';
          modes.push(options.permissionMode);
          started.push({
            key,
            prompt: options.prompt,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
          });
          const sessionId = options.sessionId ?? `sess-${started.length}`;
          onEvent({ kind: 'session', sessionId, model: options.model ?? 'm', tools: 0 });
          if (!options.prompt.includes(HOLD)) {
            onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId });
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        stop: () => finish(),
      };
    });
    const session = new ChatSession(registry);
    const treePause = new TreePause({
      links: () => store.getChatLinks(),
      runs: registry,
      store: {
        get: (key) => store.getTreePause(key),
        all: () => store.getTreePauses(),
        set: (record) => store.setTreePause(record),
        clear: (key) => store.clearTreePause(key),
      },
    });
    conveyor = new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (keys) => store.findSplitPlanByTriage(keys),
        all: () => store.getSplitPlans(),
      },
      launch: async (record, groups): Promise<TaskSplitResult> => ({
        chats: groups.map((index) => {
          const chatId = `group-${ids.parent}-${index}`;
          const branch = record.groups[index]?.branch ?? '';
          store.setChatLink(chatId, {
            parentChatId: record.parentChatId,
            createdAt: now(),
            branch,
            groupIndex: index,
            stage: 'work',
          });
          const run = registry.start(chatId, { prompt: `работа ${HOLD}`, cwd: projectDir }, {});
          return {
            index,
            title: record.groups[index]?.title ?? '',
            branch,
            chatId,
            path: join(projectDir, `copy-${index}`),
            isWorktree: true,
            started: run,
            prompt: 'работа',
          };
        }),
        failures: [],
      }),
      startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
      parallel: () => ceiling,
      resume: (group) => {
        resumed.push(group.index);
        return 'sent';
      },
      log: () => undefined,
    });
    registry.setHumanStopListener(pauseOnHumanStop(store, conveyor));

    pending = new PanelPendingActions(10_000);
    app = Fastify();
    // Вызов, который действие сделало внутри панели, — перехватом на входе
    // маршрута: так видно тело, дошедшее до него, а не то, что действие вернуло.
    app.addHook('preHandler', async (request) => {
      if (/\/(resume-paused|tree\/resume)$/.test(request.url)) {
        outgoing.push({ url: request.url, body: request.body });
      }
    });
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerConfigRoutes(app, ctx);
    registerGroupRoutes(app, ctx);
    registerChatRoutes(app, ctx, registry, session);
    registerChatGroupSettingsRoutes(app, ctx);
    registerChatSplitRoutes(app, ctx, {
      runs: registry,
      providerChats: new ProviderChatService(),
      session,
      gate: treePause,
      conveyor,
    });
    registerChatTreeRoutes(app, ctx, treePause, (keys) => conveyor.view(keys));
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  });

  afterEach(async () => {
    await describeIdle();
    pending.cancelAll();
    registry.stopAll();
    await app.close();
    for (const dir of [root, projectDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    // Папку вложений маршрут отправки заводит на каждый ключ — убираем свои.
    for (const id of Object.values(ids)) {
      rmSync(join(sandboxRoot(), id), { recursive: true, force: true });
    }
  });

  const call = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-u1' },
    });

  const listPending = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json();

  /** Вызов с решением человека по его карточке; карточки нет — исход без неё. */
  const decided = async (
    name: string,
    input: unknown,
    decision: 'approve' | 'reject' = 'approve',
  ): Promise<{ card?: PanelPendingAction; result: PanelActionResult }> => {
    let settled = false;
    const running = call(name, input).then((res) => {
      settled = true;
      return res.json<PanelActionResult>();
    });
    let card: PanelPendingAction | undefined;
    while (!settled && !card) {
      [card] = await listPending();
      if (!card) await sleep(10);
    }
    if (card) {
      await app.inject({
        method: 'POST',
        url: `/api/agent/pending/${card.id}`,
        headers: { origin: ORIGIN },
        payload: { decision },
      });
    }
    return { ...(card ? { card } : {}), result: await running };
  };

  const read = async (answer: ReturnType<typeof call>) => {
    const result = (await answer).json<PanelActionResult>();
    expect(await listPending()).toEqual([]);
    return result;
  };

  const field = (card: PanelPendingAction | undefined, labelCode: string) =>
    card?.preview.fields.find((item) => item.labelCode === labelCode);

  const running = async () =>
    (
      (await app.inject({ method: 'GET', url: '/api/chat/active' })).json() as Array<{
        chatId: string;
        sessionId?: string;
        status: string;
      }>
    ).filter((run) => run.status === 'running');

  /** Ход, который держится до «Стоп», — прямо маршрутом отправки, как из окна. */
  const holdTurn = async (chatId: string) => {
    const answer = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      headers: { origin: ORIGIN },
      payload: { chatId, sessionId: chatId, prompt: `занят ${HOLD}`, projectPath: projectDir },
      payloadAsStream: true,
    });
    answer.stream().destroy();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await running()).some((run) => run.chatId === chatId)) return;
      await sleep(10);
    }
    throw new Error('ход так и не начался');
  };

  it('read_chat: лента по названию, маска секрета, предложение разделения и вопрос агента', async () => {
    const result = await read(call('read_chat', { chat: 'сделай форму входа и тесты. токен ' }));
    // Название совпадает без учёта регистра только целиком — тут нет: отказ.
    expect(result.outcome).toBe('failed');

    const byId = await read(call('read_chat', { chat: ids.main }));
    expect(byId.outcome).toBe('done');
    const view = byId.result as {
      chat: { id: string; running: boolean; awaitingReply?: boolean };
      messages: Array<{ role: string; text: string; split?: { groups: unknown[] } }>;
      splitProposal?: { groups: Array<{ title: string; tasks: string[] }>; note: string };
      question?: { questions: Array<{ question: string; options: string[] }> };
    };
    expect(view.chat).toMatchObject({ id: ids.main, running: false, awaitingReply: true });
    const text = JSON.stringify(view);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('••••••');
    // Блок предложения не течёт сырым JSON — он разобран в группы.
    expect(text).not.toContain(SPLIT_BLOCK_LANG);
    expect(view.splitProposal?.groups.map((group) => group.title)).toEqual([
      'Форма входа',
      'Тесты',
    ]);
    expect(view.splitProposal?.note).toMatch(/Разделить на 2 чата/);
    expect(view.question?.questions[0]).toMatchObject({
      question: 'Какие браузеры поддерживать?',
      options: ['Все (Recommended)', 'Только Chrome'],
    });
  });

  it('read_chat: неизвестный чат и два чата с одним названием — отказ с подсказкой', async () => {
    const missing = await read(call('read_chat', { chat: 'нет такого' }));
    expect(missing).toMatchObject({ outcome: 'failed' });
    expect(missing.message).toMatch(/list_chats|search_chats/);
    const twins = await read(call('read_chat', { chat: 'дубль' }));
    expect(twins.outcome).toBe('failed');
    expect(twins.message).toContain(ids.twinA);
    expect(twins.message).toContain(ids.twinB);
  });

  it('search_chats: находит по телу переписки и маскирует сниппет; короткий запрос — отказ', async () => {
    const found = await read(call('search_chats', { query: 'ракеты' }));
    expect(found.outcome).toBe('done');
    expect(found.result).toMatchObject({ hits: [{ id: ids.other }] });
    const masked = await read(call('search_chats', { query: 'Токен' }));
    expect(JSON.stringify(masked.result)).not.toContain(SECRET);
    expect((await read(call('search_chats', { query: 'р' }))).outcome).toBe('invalid');
  });

  it('list_chat_projects: папки чатов со счётчиком и последним чатом, без песочницы и ключа', async () => {
    const result = await read(call('list_chat_projects', {}));
    expect(result.outcome).toBe('done');
    const view = result.result as {
      total: number;
      projects: Array<{
        path: string;
        chats: number;
        missing?: boolean;
        latestChat?: { id: string; title: string };
      }>;
    };
    expect(view.total).toBe(1);
    const [project] = view.projects;
    expect(project?.path.toLowerCase()).toBe(projectDir.toLowerCase());
    expect(project?.chats).toBe(5);
    expect(project?.missing).toBeUndefined();
    expect(Object.values(ids)).toContain(project?.latestChat?.id);
    expect(JSON.stringify(result)).not.toContain(SECRET);

    const limited = await read(call('list_chat_projects', { limit: 0 }));
    expect(limited.outcome).toBe('invalid');
  });

  it('list_waiting: чат с вопросом агента — в списке, молчащий — нет', async () => {
    const waiting = await read(call('list_waiting', {}));
    expect(waiting.outcome).toBe('done');
    const chats = (waiting.result as { chats: Array<{ id: string; status: string }> }).chats;
    expect(chats).toContainEqual(expect.objectContaining({ id: ids.main, status: 'waiting' }));
    expect(chats.map((chat) => chat.id)).not.toContain(ids.other);
  });

  it('send_chat_message: карточка, одобрение — ход в той же сессии; отказ — ничего', async () => {
    const rejected = await decided(
      'send_chat_message',
      { chat: ids.other, message: 'не отправлять' },
      'reject',
    );
    expect(rejected.result.outcome).toBe('rejected');
    expect(started).toEqual([]);

    const { card, result } = await decided('send_chat_message', {
      chat: 'почини сборку ракеты',
      message: 'Сначала прогони тесты',
    });
    expect(card).toMatchObject({ name: 'send_chat_message', risk: 'danger' });
    expect(field(card, 'label-message')?.value).toBe('Сначала прогони тесты');
    expect(field(card, 'label-chat-state')?.valueCode).toBe('value-chat-idle');
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ sent: true, chatId: ids.other });
    expect(result.page).toMatchObject({ route: '/chat', focus: ids.other });
    expect(started).toEqual([
      expect.objectContaining({ prompt: 'Сначала прогони тесты', sessionId: ids.other }),
    ]);
  });

  it('send_chat_message: право правок — тумблер чата, а не просьба модели (ревью 28.09, M3)', async () => {
    // У чата правок нет: `allowEdits: true` от модели не превращает ход в ход с правками.
    const { card, result } = await decided('send_chat_message', {
      chat: ids.other,
      message: 'Поправь файл',
      allowEdits: true,
    });
    expect(field(card, 'label-file-edits')?.valueCode).toBe('value-edits-denied');
    expect(result.outcome).toBe('done');
    expect(started).toHaveLength(1);
    expect(modes).toEqual(['default']);
  });

  it('send_chat_message: занятый чат — карточка это говорит, сообщение встаёт в очередь', async () => {
    await holdTurn(ids.other);
    const { card, result } = await decided('send_chat_message', {
      chat: ids.other,
      message: 'после хода',
    });
    expect(field(card, 'label-chat-state')?.valueCode).toBe('value-chat-busy-queued');
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ queued: true });
    // До конца хода второго прогона нет.
    expect(started.filter((run) => run.prompt === 'после хода')).toEqual([]);
  });

  it('request_split: стандартная просьба уходит в чат, карточка — без текста просьбы; песочница — отказ', async () => {
    const { card, result } = await decided('request_split', { chat: ids.main });
    expect(card).toMatchObject({ name: 'request_split', risk: 'danger' });
    const cardText = JSON.stringify(card?.preview);
    expect(cardText).not.toContain('Split the tasks of this conversation');
    expect(field(card, 'label-what-happens')?.valueCode).toBe('value-split-next-human');
    expect(result.outcome).toBe('done');
    expect(started).toHaveLength(1);
    expect(started[0]?.prompt).toMatch(/^Split the tasks of this conversation/);
    expect(started[0]?.sessionId).toBe(ids.main);
    // План не заведён: разделяет только человек своей кнопкой.
    expect(store.getSplitPlans()).toEqual({});

    const sandbox = await decided('request_split', { chat: ids.sandbox });
    expect(sandbox.card).toBeUndefined();
    expect(sandbox.result.outcome).toBe('failed');
  });

  it('split_decline: отметка «работать здесь» ставится только по одобрению', async () => {
    const rejected = await decided('split_decline', { chat: ids.main }, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(registry.isSplitMuted(ids.main)).toBe(false);
    const { card, result } = await decided('split_decline', { chat: ids.main });
    expect(card).toMatchObject({ name: 'split_decline', risk: 'change' });
    expect(result.outcome).toBe('done');
    expect(registry.isSplitMuted(ids.main)).toBe(true);
  });

  it('set_chat_group: группа по имени и автономность; чужая проектная группа — отказ', async () => {
    const global = {
      id: 'fast',
      name: 'Быстрая',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      projectPaths: [],
      isEnabled: false,
      order: 0,
      when: '',
    } as unknown as Group;
    store.saveGroup(global);
    store.saveGroup({
      ...global,
      id: 'alien',
      name: 'Чужая',
      scope: { kind: 'project', path: join(tmpdir(), 'somewhere-else'), provider: 'claude' },
    } as unknown as Group);

    const { card, result } = await decided('set_chat_group', {
      chat: ids.other,
      group: 'быстрая',
      autonomous: false,
    });
    expect(card).toMatchObject({ name: 'set_chat_group', risk: 'change' });
    expect(card?.preview.diff).toContain('Быстрая');
    expect(result.outcome).toBe('done');
    expect(store.getChatGroupSettings(ids.other)).toEqual({
      groupChoice: 'global:fast',
      autonomous: false,
    });

    // Та же правка второй раз — менять нечего, карточки нет.
    const same = await decided('set_chat_group', { chat: ids.other, group: 'global:fast' });
    expect(same.card).toBeUndefined();
    expect(same.result.outcome).toBe('failed');

    const alien = await decided('set_chat_group', { chat: ids.other, group: 'Чужая' });
    expect(alien.card).toBeUndefined();
    expect(alien.result.outcome).toBe('failed');
    expect(store.getChatGroupSettings(ids.other)?.groupChoice).toBe('global:fast');
  });

  it('stop_chat_run: идущий ход останавливается по одобрению; молчащий чат — отказ до карточки', async () => {
    const idle = await decided('stop_chat_run', { chat: ids.main });
    expect(idle.card).toBeUndefined();
    expect(idle.result.outcome).toBe('failed');
    expect(idle.result.message).toMatch(/not running/);

    await holdTurn(ids.main);
    const { card, result } = await decided('stop_chat_run', { chat: ids.main });
    expect(card).toMatchObject({ name: 'stop_chat_run', risk: 'change' });
    expect(result.outcome).toBe('done');
    expect((await running()).map((run) => run.chatId)).not.toContain(ids.main);
  });

  describe('split_control', () => {
    beforeEach(async () => {
      await conveyor.begin({
        parentChatId: ids.parent,
        projectPath: projectDir,
        proposal: {
          groups: [
            { title: 'Раз', branch: 'feature/one', tasks: ['первая'] },
            { title: 'Два', branch: 'feature/two', tasks: ['вторая'] },
            { title: 'Три', branch: 'feature/three', tasks: ['третья'] },
          ],
        },
        request: {},
      });
      conveyor.onTriageFinished(
        {
          chatId: 'triage',
          projectPath: projectDir,
          ok: true,
          startedAt: 1,
          text: [
            'Развёл.',
            '```' + SPLIT_PLAN_BLOCK_LANG,
            JSON.stringify({
              groups: [{ index: 3, after: [1, 2], hold: 'какие браузеры?' }],
              order: [1, 2, 3],
            }),
            '```',
          ].join('\n'),
        } as Parameters<SplitConveyor['onTriageFinished']>[0],
        ['triage'],
      );
      await sleep(30);
    });

    const group = (index: number) => store.getSplitPlan(ids.parent)?.groups[index];

    it('read_chat показывает план разделения родителя', async () => {
      const view = (await read(call('read_chat', { chat: ids.parent }))).result as {
        split?: { parentChatId: string; groups: Array<{ index: number; status: string }> };
      };
      expect(view.split?.parentChatId).toBe(ids.parent);
      expect(view.split?.groups.map((item) => item.status)).toEqual(['started', 'started', 'held']);
    });

    it('пауза и продолжение группы, ответ на вопрос разбора и «отпустить»', async () => {
      const pause = await decided('split_control', {
        chat: ids.parent,
        mode: 'pause_group',
        group: 'Раз',
      });
      expect(pause.card?.preview.summaryCode).toBe('summary-split-pause');
      expect(pause.result.outcome).toBe('done');
      expect(group(0)?.status).toBe('paused');

      const resume = await decided('split_control', {
        chat: ids.parent,
        mode: 'resume_group',
        group: 0,
      });
      expect(resume.result.outcome).toBe('done');
      expect(resumed).toEqual([0]);

      // Отвечать нечего у группы без вопроса — отказ до карточки.
      const noQuestion = await decided('split_control', {
        chat: ids.parent,
        mode: 'answer_group',
        group: 1,
        answer: 'все',
      });
      expect(noQuestion.card).toBeUndefined();
      expect(noQuestion.result.outcome).toBe('failed');

      const answer = await decided('split_control', {
        chat: ids.parent,
        mode: 'answer_group',
        group: 'Три',
        answer: 'Все браузеры',
      });
      expect(field(answer.card, 'label-question')?.value).toBe('какие браузеры?');
      expect(answer.result.outcome).toBe('done');
      expect(group(2)?.holdAnswer).toBe('Все браузеры');

      const release = await decided('split_control', {
        chat: ids.parent,
        mode: 'release_group',
        group: 2,
      });
      expect(release.result.outcome).toBe('done');
      expect(group(2)?.status).toBe('started');
    });

    it('продолжение паузы из очереди честно говорит: группа вернётся в очередь', async () => {
      const plan = store.getSplitPlan(ids.parent);
      const queued = plan?.groups[2];
      if (!plan || !queued) throw new Error('нет группы');
      queued.status = 'pending';
      delete queued.hold;
      delete queued.startedAt;
      delete queued.chatId;
      delete queued.path;
      store.setSplitPlan(plan);
      const pause = await decided('split_control', {
        chat: ids.parent,
        mode: 'pause_group',
        group: 2,
      });
      // N7: у группы из очереди прогонов нет — карточка не обещает их остановить.
      expect(field(pause.card, 'label-what-happens')?.valueCode).toBe(
        'value-split-pause-queued-effect',
      );
      expect(pause.result.outcome).toBe('done');

      const resume = await decided('split_control', {
        chat: ids.parent,
        mode: 'resume_group',
        group: 2,
      });
      expect(field(resume.card, 'label-what-happens')?.valueCode).toBe(
        'value-split-requeue-effect',
      );
      expect(resume.result.outcome).toBe('done');
      expect(group(2)?.status).not.toBe('paused');
    });

    it('пауза и продолжение всего дерева', async () => {
      const pauseAll = await decided('split_control', { chat: ids.parent, mode: 'pause_all' });
      expect(pauseAll.card?.preview.summaryCode).toBe('summary-tree-pause');
      expect(pauseAll.result.outcome).toBe('done');
      expect(store.getTreePause(ids.parent)).toBeDefined();
      expect(await running()).toEqual([]);

      // Уже стоит — второй паузы не будет.
      const again = await decided('split_control', { chat: ids.parent, mode: 'pause_all' });
      expect(again.card).toBeUndefined();
      expect(again.result.outcome).toBe('failed');

      const resumeAll = await decided('split_control', { chat: ids.parent, mode: 'resume_all' });
      expect(resumeAll.result.outcome).toBe('done');
      expect(store.getTreePause(ids.parent)).toBeUndefined();
    });

    it('force не уходит ни группе, ни дереву; пауза продолжается своим местом', async () => {
      const pause = await decided('split_control', {
        chat: ids.parent,
        mode: 'pause_group',
        group: 0,
      });
      expect(pause.result.outcome).toBe('done');
      expect(group(0)?.status).toBe('paused');

      // Потолок полон, но пауза держит своё место (живой прогон 29.09): группа
      // продолжается без согласия, и согласия агент всё равно не шлёт.
      ceiling = 1;
      const resume = await decided('split_control', {
        chat: ids.parent,
        mode: 'resume_group',
        group: 0,
      });
      const toGroup = outgoing.filter((call) => call.url.endsWith('/resume-paused'));
      expect(toGroup).toHaveLength(1);
      expect((toGroup[0]?.body as { force?: unknown }).force).toBeUndefined();
      expect(resume.result.outcome).toBe('done');
      expect(resumed).toHaveLength(1);

      const pauseAll = await decided('split_control', { chat: ids.parent, mode: 'pause_all' });
      expect(pauseAll.result.outcome).toBe('done');
      const resumeAll = await decided('split_control', { chat: ids.parent, mode: 'resume_all' });
      expect(resumeAll.result.outcome).toBe('done');
      const toTree = outgoing.filter((call) => call.url.endsWith('/tree/resume'));
      expect(toTree).toHaveLength(1);
      expect((toTree[0]?.body as { force?: unknown } | undefined)?.force).toBeUndefined();
    });

    it('разделения нет — режимы групп отказывают до карточки', async () => {
      const none = await decided('split_control', {
        chat: ids.other,
        mode: 'pause_group',
        group: 0,
      });
      expect(none.card).toBeUndefined();
      expect(none.result.outcome).toBe('failed');
    });
  });
});
