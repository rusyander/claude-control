import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatInbox } from '@agentdeck/contracts/chat-inbox';
import { chatInboxSchema } from '@agentdeck/contracts/chat-inbox';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { translate, type ChatEvent, type RawEvent } from '../../domains/chat/ChatRunner.ts';
import { registerChatRunRoutes } from './run-routes.ts';
import { registerChatInboxRoutes } from './inbox-routes.ts';

/**
 * Сводка ожиданий поверх НАСТОЯЩИХ маршрутов: брокер прав, реестр прогонов и
 * чтение транскрипта — настоящие; заглушен только процесс CLI (он не
 * заканчивается сам, чтобы запрос прав было кому держать). Вопрос теста —
 * видит ли телефон висящий запрос и вопрос агента с подписью «чей», и снимает
 * ли их ответ, отправленный тем же маршрутом, что у ленты.
 */
describe('GET /api/chat/inbox', () => {
  let root: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  const CHAT = 'new-inbox-chat';
  const SESSION = 'inbox-session';
  let transcript: string;

  /** Следующий прогон кончается сам — ход, закончившийся в окне догона реестра. */
  let finishNext = false;
  /** Поток CLI текущего прогона: строки `stream-json` идут тем же разбором, что у живого. */
  let cliLine: (raw: RawEvent) => void = () => undefined;
  const liveRun = (): RunLike => {
    const finish = finishNext;
    finishNext = false;
    return {
      start: (_options: unknown, onEvent: (event: ChatEvent) => void) => {
        cliLine = (raw) => {
          for (const event of translate(raw)) onEvent(event);
        };
        return finish ? Promise.resolve() : new Promise(() => undefined);
      },
      stop: () => undefined,
    };
  };

  const line = (record: unknown) => appendFileSync(transcript, `${JSON.stringify(record)}\n`);
  const inbox = async (): Promise<ChatInbox> => {
    const response = await app.inject({ method: 'GET', url: '/api/chat/inbox' });
    expect(response.statusCode).toBe(200);
    // Ответ обязан проходить схему контракта: телефон читает его по ней.
    return chatInboxSchema.parse(response.json());
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-inbox-routes-'));
    const project = join(root, 'work', 'shop');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(root, 'projects', 'C--work-shop'), { recursive: true });
    transcript = join(root, 'projects', 'C--work-shop', `${SESSION}.jsonl`);
    writeFileSync(transcript, '');
    const now = new Date().toISOString();
    line({
      type: 'user',
      uuid: 'u0',
      cwd: project,
      timestamp: now,
      message: { role: 'user', content: 'Почини корзину' },
    });

    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    registry = new ChatRunRegistry(liveRun);
    session = new ChatSession(registry);
    const ctx = {
      store: new AppStore(join(root, 'agentdeck')),
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          appData: join(root, 'agentdeck'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, session);
    registerChatInboxRoutes(app, ctx, registry, session);
    await app.ready();
    registry.start(
      CHAT,
      { prompt: 'Почини корзину', cwd: project, sessionId: SESSION },
      { projectPath: project, sessionId: SESSION },
    );
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('висящий запрос прав виден с подписью чата и снимается решением из ленты', async () => {
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: {
        runId: CHAT,
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        toolUseId: 't1',
      },
    });
    let seen: ChatInbox | undefined;
    for (let attempt = 0; attempt < 100 && !seen?.chats[0]?.asks.length; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
      seen = await inbox();
    }

    const chat = seen?.chats.find((item) => item.id === SESSION);
    expect(chat).toMatchObject({
      runKey: CHAT,
      sessionId: SESSION,
      title: 'Почини корзину',
      project: 'shop',
      status: 'waiting',
      running: true,
    });
    expect(chat?.asks).toEqual([
      expect.objectContaining({
        kind: 'permission',
        key: 'p:t1',
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
      }),
    ]);

    const decided = await app.inject({
      method: 'POST',
      url: `/api/chat/${chat?.runKey}/permission-decision`,
      payload: { toolUseId: 't1', behavior: 'allow' },
    });
    expect(decided.json()).toEqual({ ok: true });
    expect((await pending).json()).toMatchObject({ behavior: 'allow' });

    const after = (await inbox()).chats.find((item) => item.id === SESSION);
    expect(after?.asks).toEqual([]);
    expect(after?.status).toBe('running');
  });

  it('CLI оборвал запрос прав: карточка уходит, ответ на неё — 410 «истёк», повтор — одна карточка', async () => {
    const held = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: {
        runId: CHAT,
        toolName: 'Write',
        input: { file_path: 'a.txt' },
        toolUseId: 't-dead',
      },
    });
    let seen: ChatInbox | undefined;
    for (let attempt = 0; attempt < 100 && !seen?.chats[0]?.asks.length; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
      seen = await inbox();
    }
    expect(seen?.chats[0]?.asks.map((ask) => ask.key)).toEqual(['p:t-dead']);

    // Так CLI 2.1.282 сообщает об обрыве по сроку простоя: результат вызова-ошибка.
    cliLine({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't-dead',
            is_error: true,
            content:
              '<tool_use_error>Error calling tool (Write): MCP server "perm-guard" tool "approve" sent no response or progress for 1800s; aborting.</tool_use_error>',
          },
        ],
      },
      // `is_error` панель в строке потока не читает — в типе его нет.
    } as unknown as RawEvent);

    // Держатель запроса отпущен отказом с пометкой — мост не висит зря.
    expect((await held).json()).toMatchObject({ behavior: 'deny', expired: true });
    expect((await inbox()).chats[0]?.asks).toEqual([]);
    // Поток вкладок: карточка снята как «истекла», а внутреннее событие реестра
    // до клиентов не доезжает.
    const streamed: ChatEvent[] = [];
    registry.attach(CHAT, 0, {
      send: (buffered) => streamed.push(buffered.event),
      close: () => undefined,
    });
    expect(streamed.some((event) => event.kind === 'toolResult')).toBe(false);
    expect(streamed).toContainEqual({
      kind: 'permissionResolved',
      toolUseId: 't-dead',
      behavior: 'deny',
      expired: true,
    });

    // Ответ на умерший — не «принято», а явный отказ с кодом текста.
    const late = await app.inject({
      method: 'POST',
      url: `/api/chat/${CHAT}/permission-decision`,
      payload: { toolUseId: 't-dead', behavior: 'allow' },
    });
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({
      code: 'permission_expired',
      messageCode: 'permission-expired',
    });
    const lateGate = await app.inject({
      method: 'POST',
      url: `/api/chat/${CHAT}/branch-decision`,
      payload: { toolUseId: 't-dead', choice: 'here' },
    });
    expect(lateGate.statusCode).toBe(410);

    // Агент спросил снова — в сводке ровно одна карточка, новая.
    const retry = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: {
        runId: CHAT,
        toolName: 'Write',
        input: { file_path: 'a.txt' },
        toolUseId: 't-retry',
      },
    });
    let again: ChatInbox | undefined;
    for (let attempt = 0; attempt < 100 && !again?.chats[0]?.asks.length; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
      again = await inbox();
    }
    expect(again?.chats[0]?.asks.map((ask) => ask.key)).toEqual(['p:t-retry']);
    const answered = await app.inject({
      method: 'POST',
      url: `/api/chat/${CHAT}/permission-decision`,
      payload: { toolUseId: 't-retry', behavior: 'allow' },
    });
    expect(answered.json()).toEqual({ ok: true });
    expect((await retry).json()).toMatchObject({ behavior: 'allow' });
  });

  it('результат вызова после ответа человека ничего не ломает: живой ответ не становится «истёк»', async () => {
    const held = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: CHAT, toolName: 'Write', input: {}, toolUseId: 't-ok' },
    });
    for (let attempt = 0; attempt < 100 && !(await inbox()).chats[0]?.asks.length; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const decided = await app.inject({
      method: 'POST',
      url: `/api/chat/${CHAT}/permission-decision`,
      payload: { toolUseId: 't-ok', behavior: 'allow' },
    });
    expect(decided.json()).toEqual({ ok: true });
    expect((await held).json()).toMatchObject({ behavior: 'allow' });
    // CLI исполнил вызов и вернул результат — запрос уже снят, «истёк» не появляется.
    cliLine({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't-ok', content: 'File created' }] },
    } as RawEvent);
    expect(session.isPermissionExpired(CHAT, 't-ok')).toBe(false);
  });

  it('вопрос агента из транскрипта — строками по одному; реплика человека его снимает', async () => {
    const at = new Date().toISOString();
    line({
      type: 'assistant',
      uuid: 'a1',
      timestamp: at,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'q1',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Какую скидку?',
                  header: 'Скидка',
                  options: [{ label: '5%' }, { label: '10%' }],
                },
                {
                  question: 'Что проверить?',
                  multiSelect: true,
                  options: [{ label: 'Юниты' }, { label: 'E2E' }],
                },
              ],
            },
          },
        ],
      },
    });
    // Отказ брокера панели — не ответ: он и говорит агенту ждать сообщения.
    line({
      type: 'user',
      uuid: 'u1',
      timestamp: at,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'q1', is_error: true, content: 'ответ придёт' },
        ],
      },
    });

    const chat = (await inbox()).chats.find((item) => item.id === SESSION);
    expect(chat?.status).toBe('waiting');
    expect(chat?.asks.map((ask) => ask.key)).toEqual(['q:q1:0', 'q:q1:1']);
    expect(chat?.asks[1]).toMatchObject({
      kind: 'question',
      index: 1,
      total: 2,
      question: { question: 'Что проверить?', multiSelect: true },
    });

    line({
      type: 'user',
      uuid: 'u2',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Скидка: 5%\nЧто проверить?: E2E' },
    });
    const answered = (await inbox()).chats.find((item) => item.id === SESSION);
    expect(answered?.asks).toEqual([]);
  });

  it('запрос прав умершего прогона не показывается: ответить на него некуда', async () => {
    void session.requestPermission({
      runId: 'gone-run',
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 't9',
    });
    const all = await inbox();
    expect(all.chats.flatMap((chat) => chat.asks)).toEqual([]);
    session.decidePermission('gone-run', 't9', { behavior: 'deny' });
  });

  it('законченный ход в окне догона — не «работает»: реестр его ещё отдаёт, сводка — нет', async () => {
    finishNext = true;
    registry.start(
      'new-done-chat',
      { prompt: 'Готово', cwd: join(root, 'work', 'shop') },
      { projectPath: join(root, 'work', 'shop') },
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (registry.active().some((run) => run.chatId === 'new-done-chat' && run.status === 'done'))
        break;
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(registry.active().find((run) => run.chatId === 'new-done-chat')?.status).toBe('done');
    const all = await inbox();
    expect(all.chats.find((chat) => chat.runKey === 'new-done-chat')).toBeUndefined();
    expect(all.chats.filter((chat) => chat.running).map((chat) => chat.runKey)).toEqual([CHAT]);
  });

  /**
   * Ревью 28.09 (F-103): мост прав берёт ключ хода из файла, и неудачная его
   * запись оставляет прошлый ключ — `sessionId` разговора. Ворота маршрута его
   * узнают (`describe` сводит синонимы), а брокер хранил запрос под синонимом:
   * сводка телефона его не видела, ответ по ключу прогона уходил в «отложено».
   */
  it('запрос прав под вторым написанием ключа виден в сводке и снимается ответом', async () => {
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: {
        runId: SESSION,
        toolName: 'Bash',
        input: { command: 'npm publish' },
        toolUseId: 't-alias',
      },
    });
    let seen: ChatInbox | undefined;
    for (let attempt = 0; attempt < 100 && !seen?.chats[0]?.asks.length; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
      seen = await inbox();
    }
    const chat = seen?.chats.find((item) => item.id === SESSION);
    expect(chat?.asks.map((ask) => ask.key)).toEqual(['p:t-alias']);
    expect(chat?.status).toBe('waiting');

    const decided = await app.inject({
      method: 'POST',
      url: `/api/chat/${CHAT}/permission-decision`,
      payload: { toolUseId: 't-alias', behavior: 'allow' },
    });
    expect(decided.json()).toEqual({ ok: true });
    expect((await pending).json()).toMatchObject({ behavior: 'allow' });
    expect((await inbox()).chats.find((item) => item.id === SESSION)?.asks).toEqual([]);
  });

  it('остановка снимает запрос, пришедший под вторым написанием ключа', async () => {
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: {
        runId: SESSION,
        toolName: 'Bash',
        input: { command: 'npm publish --tag next' },
        toolUseId: 't-stop',
      },
    });
    for (let attempt = 0; attempt < 100 && !(await inbox()).chats[0]?.asks.length; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    session.abort(CHAT);
    expect((await pending).json()).toMatchObject({ behavior: 'deny' });
  });
});
