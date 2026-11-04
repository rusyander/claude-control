import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { SPLIT_BLOCK_LANG } from '@agentdeck/contracts/task-split';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { registerAccessGate } from '../../../lib/access-gate/access-gate.ts';
import { registerEmptyBodyGuard } from '../../../lib/empty-body.ts';
import { createEventHub } from '../../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../../lib/origin-guard/origin-guard.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../../domains/chat/run-options/run-options.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { sandboxRoot } from '../../../domains/chat/ChatArtifacts/ChatArtifacts.ts';
import { TreePause } from '../../../domains/chat/tree-pause/tree-pause.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import { registerConfigRoutes } from '../../config-routes/config-routes.ts';
import { registerChatRoutes } from '../../chat-routes/chat-routes.ts';
import { registerChatTreeRoutes } from '../../chat/tree-routes/tree-routes.ts';
import { registerPanelAgentRoutes } from '../panel-agent-routes/panel-agent-routes.ts';

/**
 * Действия агента над чатами (U1) на настоящих маршрутах панели: список чатов
 * и лента из транскриптов на диске, реестр прогонов, пауза дерева. Подменён
 * только процесс CLI (фабрика прогонов реестра). Доказательство — что дошло
 * до процесса (промпт, сессия, модель), реестр прогонов и хранилище, а не
 * текст ответа действия. Групп разделения нет с этапа 10: их действия ушли
 * (см. registry-strict), осталась пауза дерева.
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
  let pending: PanelPendingActions;
  let app: FastifyInstance;
  let started: Started[];
  /** Режим прав каждого запущенного хода — чем CLI на деле разрешено править. */
  let modes: Array<string | undefined>;
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
    // Свежий файл с репликой человека в хвосте — открытый ход вне панели
    // (терминал, VS Code). «Молчащий» чат старше окна живости.
    const silentSince = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(root, 'projects', 'demo', `${ids.other}.jsonl`), silentSince, silentSince);
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
    pending = new PanelPendingActions(10_000);
    app = Fastify();
    // Вызов, который действие сделало внутри панели, — перехватом на входе
    // маршрута: так видно тело, дошедшее до него, а не то, что действие вернуло.
    app.addHook('preHandler', async (request) => {
      if (/\/tree\/resume$/.test(request.url)) {
        outgoing.push({ url: request.url, body: request.body });
      }
    });
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerConfigRoutes(app, ctx);
    registerChatRoutes(app, ctx, registry, session);
    registerChatTreeRoutes(app, ctx, treePause);
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  });

  afterEach(async () => {
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

  it('read_chat: лента по названию, маска секрета, блок прежнего разделения вырезан, вопрос агента', async () => {
    const result = await read(call('read_chat', { chat: 'сделай форму входа и тесты. токен ' }));
    // Название совпадает без учёта регистра только целиком — тут нет: отказ.
    expect(result.outcome).toBe('failed');

    const byId = await read(call('read_chat', { chat: ids.main }));
    expect(byId.outcome).toBe('done');
    const view = byId.result as {
      chat: { id: string; running: boolean; awaitingReply?: boolean };
      messages: Array<{ role: string; text: string }>;
      splitProposal?: { groups: Array<{ title: string; tasks: string[] }>; note: string };
      question?: { questions: Array<{ question: string; options: string[] }> };
    };
    expect(view.chat).toMatchObject({ id: ids.main, running: false, awaitingReply: true });
    const text = JSON.stringify(view);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('••••••');
    // Блок прежнего предложения разделения не течёт сырым JSON и больше не
    // разбирается в группы: разделения нет, задачи ведёт ядро (этап 10).
    expect(text).not.toContain(SPLIT_BLOCK_LANG);
    expect(text).toContain('Предлагаю разделить.');
    expect(view.splitProposal).toBeUndefined();
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

  // Этап 10: групп разделения нет — у split_control остались только режимы дерева.
  it('split_control: пауза и продолжение всего дерева; повторная пауза — отказ до карточки', async () => {
    await holdTurn(ids.parent);
    const pauseAll = await decided('split_control', { chat: ids.parent, mode: 'pause_all' });
    expect(pauseAll.card?.preview.summaryCode).toBe('summary-tree-pause');
    expect(field(pauseAll.card, 'label-what-happens')?.valueCode).toBe('value-tree-pause-effect');
    expect(pauseAll.result.outcome).toBe('done');
    expect(store.getTreePause(ids.parent)).toBeDefined();
    expect(await running()).toEqual([]);

    // Уже стоит — второй паузы не будет.
    const again = await decided('split_control', { chat: ids.parent, mode: 'pause_all' });
    expect(again.card).toBeUndefined();
    expect(again.result.outcome).toBe('failed');

    const view = (await read(call('read_chat', { chat: ids.parent }))).result as {
      treePaused?: { since: string };
    };
    expect(view.treePaused?.since).toBeTruthy();

    const resumeAll = await decided('split_control', { chat: ids.parent, mode: 'resume_all' });
    expect(resumeAll.card?.preview.summaryCode).toBe('summary-tree-resume');
    expect(resumeAll.result.outcome).toBe('done');
    expect(store.getTreePause(ids.parent)).toBeUndefined();
    // force (согласие сверх потолка) агент не шлёт.
    const toTree = outgoing.filter((item) => item.url.endsWith('/tree/resume'));
    expect(toTree).toHaveLength(1);
    expect((toTree[0]?.body as { force?: unknown } | undefined)?.force).toBeUndefined();

    const notPaused = await decided('split_control', { chat: ids.parent, mode: 'resume_all' });
    expect(notPaused.card).toBeUndefined();
    expect(notPaused.result.outcome).toBe('failed');
  });

  // Этап 10, F2b: «Продолжить» сдавшуюся группу — ответ ядру «continue» на вопрос потолка кругов,
  // а его ядро принимает только с доказательством человека. Отказ назван, до карточки и до ядра.
  it('split_control: «Продолжить» сдавшуюся задачу — названный отказ без карточки, ничего не исполнено', async () => {
    const result = await decided('split_control', { chat: ids.parent, mode: 'continue_group' });
    expect(result.card).toBeUndefined();
    expect(result.result.outcome).toBe('failed');
    expect(result.result.message).toContain('core-continue-human-only');
    expect(await listPending()).toEqual([]);
    expect(store.getTreePause(ids.parent)).toBeUndefined();
  });

  it('split_control: режимы одной группы ушли — вход их отклоняет без карточки', async () => {
    for (const mode of ['pause_group', 'resume_group', 'answer_group', 'release_group']) {
      const result = await read(call('split_control', { chat: ids.parent, mode, group: 0 }));
      expect(result.outcome).toBe('invalid');
    }
  });
});
