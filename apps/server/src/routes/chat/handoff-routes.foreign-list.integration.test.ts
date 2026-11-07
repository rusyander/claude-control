import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessagesPage, ChatSummary } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import {
  coreChatBookPath,
  createCoreChatBook,
} from '../../domains/chat/core-run/core-chat-book.ts';
import { createCoreChatHistory } from '../../domains/chat/core-run/core-chat-history.ts';
import { CoreChatRun } from '../../domains/chat/core-run/core-run.ts';
import { coreWithTurns } from '../../domains/chat/core-run/__fixtures__/core-with-turns.ts';
import { getActiveProviderId } from '../../providers/registry.ts';
import { registerChatRunRoutes } from './run-routes/run-routes.ts';
import { registerChatHandoffRoutes } from './handoff-routes.ts';
import { registerChatTranscriptRoutes } from './transcript-routes/transcript-routes.ts';

/**
 * Продолжение в чистой сессии к не-Claude CLI (этап 11, волна 3). Раньше оно заводило задачу ядра
 * мимо реестра прогонов: без id разговора и без записи в книге чата ядра — разговор не попадал в
 * список (боковая панель и `/api/chats/projects` телефона), не открывался заново, история не
 * читалась. Теперь оно садится как продолжение Claude: прогон реестра под ключом `new-…` → прогон
 * ядра называет разговор id сеанса, книга помнит его, список и лента читают его из видов сеансов.
 *
 * Настоящие: маршруты продолжения, отправки и списка, реестр, `CoreChatRun`, файл книги, чтение
 * истории. Подменено только ядро за HTTP (другой процесс): оценка, команды и вид задачи —
 * `stubCorePort`, а поток сеанса отдаёт каждый посланный ход с ответом, как вид сеанса ядра.
 */

const MARK = 'передача-77';
const ANSWER = 'готов';
const SESSION = 'qwen-sess';
/** Стена отправки первого хода в виде сеанса. */
const TURN_AT = 1_793_989_152_846;

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe('продолжение в чистой сессии к чужому CLI садится как продолжение Claude', () => {
  let root: string;
  let work: string;
  let appData: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let app: FastifyInstance;
  let core: ReturnType<typeof coreWithTurns>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-handoff-list-'));
    work = join(root, 'work');
    appData = join(root, 'agentdeck');
    for (const dir of [work, appData]) mkdirSync(dir, { recursive: true });
    store = new AppStore(appData);
    core = coreWithTurns({ sessionId: SESSION, answer: ANSWER, turnAt: TURN_AT });
    const book = createCoreChatBook(coreChatBookPath(appData));
    registry = new ChatRunRegistry(
      () =>
        new CoreChatRun({
          port: core.port,
          book,
          pollMs: 5,
          activeCli: () => getActiveProviderId(store),
        }),
    );
    const ctx = {
      store,
      location: { paths: { root, appData } },
      backupDir: join(appData, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    const session = new ChatSession(registry);
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, session);
    const coreHistory = createCoreChatHistory(core.port, () => coreChatBookPath(appData));
    registerChatHandoffRoutes(app, ctx, {
      runs: registry,
      chains: new HandoffChains(),
      session,
      coreHistory,
    });
    registerChatTranscriptRoutes(app, ctx, undefined, undefined, undefined, coreHistory);
    await app.ready();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const bookFile = (): Record<string, unknown> => {
    const file = coreChatBookPath(appData);
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
      : {};
  };

  it('Qwen активен: ключ new-… отдан вкладке, прогон назвал разговор сеансом ядра, книга его помнит; он в списке, его лента читается, открытый заново — тот же шаг', async () => {
    store.updateSettings({ provider: 'qwen' });
    const reply = await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: {
        projectPath: work,
        chatId: 'claude-src',
        proposal: {
          done: 'этап закрыт',
          next: `${MARK}: продолжай`,
          checkpoint: '.agent/PROGRESS.md',
        },
      },
    });
    expect(reply.statusCode).toBe(200);
    const started = reply.json<{ chatId: string; started: boolean; path: string }>();
    // Вкладка переезжает на этот ключ (`useChatHandoff.adopt`) — как после продолжения Claude.
    expect(started).toMatchObject({ started: true, path: work });
    expect(started.chatId).toMatch(/^new-/);

    // Вкладка подхватывает прогон опросом `/api/chat/active`: под ключом `new-…`, с id разговора.
    await until(() => registry.active().some((r) => r.sessionId === SESSION));
    const active = (await app.inject({ url: '/api/chat/active' })).json<
      Array<{ chatId: string; sessionId?: string; projectPath?: string }>
    >();
    expect(active).toContainEqual(
      expect.objectContaining({ chatId: started.chatId, sessionId: SESSION, projectPath: work }),
    );
    expect(core.calls.find((c) => c.kind === 'set-cli')?.fields).toMatchObject({ adapter: 'qwen' });

    // Книга: разговор — id сеанса ядра, CLI qwen, задача, шаг и папка.
    await until(() => SESSION in bookFile());
    expect(bookFile()[SESSION]).toEqual({
      taskId: 'stub-task-1',
      stepId: 'stub-task-1-chat',
      cli: 'qwen',
      tasks: ['stub-task-1'],
      cwd: work,
    });

    // Задание — первым: по нему названа строка списка; инициатива чужого CLI — за ним.
    const request = core.estimates[0]?.request ?? '';
    expect(request.indexOf(MARK)).toBeGreaterThanOrEqual(0);
    expect(request.indexOf('This run was started from the AgentDeck panel')).toBeGreaterThan(
      request.indexOf(MARK),
    );

    await until(() => !registry.isRunning(started.chatId));

    // Список проектов (телефон) и список чатов (боковая панель): строка продолжения, названа
    // предложением, а не вводной панели.
    const projects = (await app.inject({ url: '/api/chats/projects' })).json<
      Array<{ path: string; chats: Array<{ id: string; title: string; messageCount: number }> }>
    >();
    const row = projects.find((p) => p.path === work)?.chats.find((c) => c.id === SESSION);
    expect(row).toMatchObject({ messageCount: 2 });
    expect(row?.title.startsWith(`${MARK}: продолжай`)).toBe(true);
    // Инициатива панели — хвост задания, в название не попадает (у Claude её там тоже нет).
    expect(row?.title).not.toContain('This run was started');
    const chats = (await app.inject({ url: '/api/chats' })).json<ChatSummary[]>();
    expect(chats.find((c) => c.id === SESSION)).toMatchObject({ projectPath: work });

    // Лента после F5 — из вида сеанса ядра.
    const feed = (
      await app.inject({ url: `/api/chats/${SESSION}/messages` })
    ).json<ChatMessagesPage>();
    expect(feed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(feed.messages[0]?.blocks)).toContain(MARK);
    // Инициатива ушла модели (выше), но в ленте её нет — как у продолжения Claude.
    expect(JSON.stringify(feed.messages[0]?.blocks)).not.toContain('This run was started');

    // Открыт из списка: ход идёт сообщением тому же шагу, новой задачи нет.
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: SESSION, sessionId: SESSION, prompt: 'ист-9', projectPath: work },
    });
    await until(() => core.calls.some((c) => c.kind === 'message-to-step'));
    expect(core.estimates).toHaveLength(1);
    expect(core.calls.filter((c) => c.kind === 'message-to-step')).toEqual([
      expect.objectContaining({
        taskId: 'stub-task-1',
        fields: expect.objectContaining({ stepId: 'stub-task-1-chat', text: 'ист-9' }),
      }),
    ]);
  });

  /** Разговор Qwen в один ход: книга называет его сеансом ядра, ход человека — в его истории. */
  async function qwenChat(): Promise<void> {
    store.updateSettings({ provider: 'qwen' });
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'new-1', prompt: 'ист-1', projectPath: work },
    });
    await until(() => SESSION in bookFile());
    await until(() => !registry.isRunning('new-1'));
  }

  /** Опора с временем правки относительно хода человека (`sentAt` первого хода заглушки). */
  function checkpointAt(shiftMs: number): void {
    const file = join(work, '.agent', 'PROGRESS.md');
    mkdirSync(join(work, '.agent'), { recursive: true });
    writeFileSync(file, 'Состояние.\n', 'utf8');
    const at = (TURN_AT + shiftMs) / 1000;
    utimesSync(file, at, at);
  }

  const restart = (): Promise<{ mode: string }> =>
    app
      .inject({
        method: 'POST',
        url: `/api/chat/${SESSION}/restart`,
        payload: { projectPath: work, sessionId: SESSION },
      })
      .then((r) => r.json<{ mode: string }>());

  it('перезапуск разговора Qwen: опора свежее его последнего хода — продолжение сразу, по истории ядра', async () => {
    await qwenChat();
    checkpointAt(60_000);
    expect((await restart()).mode).toBe('started');
  });

  it('перезапуск разговора Qwen: опора старше его последнего хода — просьба обновить её', async () => {
    await qwenChat();
    checkpointAt(-60_000);
    expect((await restart()).mode).toBe('requested');
  });
});
