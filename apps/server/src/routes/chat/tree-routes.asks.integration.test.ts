import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ChatAwaitingView,
  ChatTreeNode,
  ChatTreeView,
} from '@agentdeck/contracts/chat-handoff';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../../domains/chat/ChatRunner.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { TreePause } from '../../domains/chat/tree-pause.ts';
import { PENDING_ASKS_FILE, wirePendingAsks } from '../../domains/chat/pending-asks.ts';
import { registerChatRoutes } from '../chat-routes.ts';
import { registerChatTreeRoutes } from './tree-routes.ts';

/**
 * Вопросы и запросы прав группы разделения — в хабе родителя по серверной
 * записи (WP9c, журнал 30/36/62/97 g7).
 *
 * Группу здесь запускает НЕ вкладка: прогон заводится прямо реестром, как его
 * заводит конвейер, и к потоку никто не подключён. Маршруты настоящие —
 * отправка, запрос и решение прав, дерево; подменён только сам CLI (прогон,
 * который называет сессию и говорит то, что велит тест). «Перезапуск панели» —
 * новые реестр, запись и приложение над тем же каталогом данных.
 */
describe('дерево разговоров: вопросы и права групп на сервере', () => {
  let root: string;
  let data: string;
  let store: AppStore;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  /** Живые прогоны-заглушки: что им передали и как ими управлять. */
  let runs: { options: RunOptions; emit: (event: ChatEvent) => void; end: () => void }[];

  const boot = async (): Promise<void> => {
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) =>
        new Promise<void>((resolve) => {
          const id = options.permissionPrompt?.runId ?? 'x';
          onEvent({
            kind: 'session',
            sessionId: options.sessionId ?? `sess-${id}`,
            model: '',
            tools: 0,
          });
          runs.push({ options, emit: onEvent, end: resolve });
        }),
      stop: () => undefined,
    }));
    registry.setSessionListener((chatId, sessionId) => store.linkChatSession(chatId, sessionId));
    // Та же сборка, что в `bootstrap/runtime.ts`: запись подписана на реестр,
    // начало и конец хода зовут её рядом с конвейером.
    const asks = wirePendingAsks(registry, {
      file: join(data, PENDING_ASKS_FILE),
      isTreeChat: (keys) => keys.some((key) => Boolean(store.getChatLink(key)?.parentChatId)),
    });
    registry.setStartListener((keys) => asks.started(keys));
    registry.setHandoffPlanner((finished) => {
      asks.finished(finished);
      return undefined;
    });
    const tree = new TreePause({
      links: () => store.getChatLinks(),
      runs: registry,
      store: {
        get: (key) => store.getTreePause(key),
        all: () => store.getTreePauses(),
        set: (record) => store.setTreePause(record),
        clear: (key) => store.clearTreePause(key),
      },
      asksOf: (keys) => asks.of(keys, (runId) => registry.isRunning(runId)),
    });
    const ctx = { location: { paths: { root } }, store } as unknown as ServerContext;
    app = Fastify();
    registerChatRoutes(app, ctx, registry, new ChatSession(registry));
    registerChatTreeRoutes(app, ctx, tree);
    await app.ready();
  };

  const tick = (ms = 20) => new Promise((done) => setTimeout(done, ms));

  /** Группа, заведённая конвейером: без вкладки, без потока. */
  const startGroup = async (key: string): Promise<void> => {
    store.setChatLink(key, {
      parentChatId: 'parent',
      title: `Группа ${key}`,
      createdAt: '2026-09-25T10:00:00.000Z',
    });
    registry.start(
      key,
      { prompt: 'работа группы', cwd: root, permissionPrompt: { runId: key, baseUrl: 'http://x' } },
      { projectPath: root, origin: 'groups' },
    );
    await tick();
  };

  const runOf = (key: string) => {
    const run = runs.findLast((item) => item.options.permissionPrompt?.runId === key);
    if (!run) throw new Error(`no run ${key}`);
    return run;
  };

  const nodeOf = async (chatId: string): Promise<ChatTreeNode | undefined> => {
    const view = (
      await app.inject({ method: 'GET', url: '/api/chat/parent/tree' })
    ).json<ChatTreeView>();
    return view.nodes.find((node) => node.chatId === chatId);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-tree-asks-'));
    data = join(root, 'agentdeck');
    mkdirSync(data, { recursive: true });
    runs = [];
    store = new AppStore(data);
    await boot();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const QUESTION = { questions: [{ question: 'Rebase на свежий main?', options: [] }] };

  it('вопрос инструментом: карточка в дереве, переживает перезапуск, ответ доходит до группы и снимает её', async () => {
    await startGroup('new-g1');
    runOf('new-g1').emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'toolu_a' });
    await tick();

    // Посреди хода — вопрос уже виден, узел ещё «идёт».
    const during = await nodeOf('sess-new-g1');
    expect(during?.asks).toEqual([
      expect.objectContaining({ kind: 'question', toolUseId: 'toolu_a', input: QUESTION }),
    ]);
    expect(during?.status).toBe('running');

    runOf('new-g1').emit({ kind: 'text', text: 'Жду вашего ответа.' });
    runOf('new-g1').end();
    await tick();
    expect((await nodeOf('sess-new-g1'))?.status).toBe('waiting');

    // Перезапуск панели: всё в памяти пропало, запись — в файле данных.
    registry.stopAll();
    await app.close();
    await boot();
    const reborn = await nodeOf('sess-new-g1');
    expect(reborn?.asks?.[0]).toMatchObject({ kind: 'question', toolUseId: 'toolu_a' });
    expect(reborn?.status).toBe('waiting');

    // Ответ из хаба — обычная отправка в чат группы, её же сессией. Сессию
    // маршрут подтверждает транскриптом CLI — кладём его, как положил бы CLI.
    mkdirSync(join(root, 'projects', 'p'), { recursive: true });
    writeFileSync(
      join(root, 'projects', 'p', 'sess-new-g1.jsonl'),
      `${JSON.stringify({
        type: 'user',
        cwd: root,
        sessionId: 'sess-new-g1',
        message: { role: 'user', content: 'работа группы' },
      })}\n`,
    );
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'sess-new-g1', sessionId: 'sess-new-g1', prompt: 'Да, rebase' },
    });
    await tick(40);
    const answered = runs.at(-1);
    expect(answered?.options.prompt).toContain('Да, rebase');
    expect(answered?.options.sessionId).toBe('sess-new-g1');
    const after = await nodeOf('sess-new-g1');
    expect(after?.asks).toBeUndefined();
    expect(after?.status).toBe('running');
  });

  // Находка 77 живого прогона 24.09: вопрос группы, заведённой без вкладки, не
  // давал ни звука, ни уведомления. Вкладка спрашивает этот список и скрытой.
  it('список ждущих: вопрос группы виден один раз, под настоящим ключом, и после перезапуска', async () => {
    const awaiting = async () =>
      (await app.inject({ method: 'GET', url: '/api/chat/awaiting' })).json<ChatAwaitingView>()
        .chats;
    await startGroup('new-g1');
    expect(await awaiting()).toEqual([]);

    runOf('new-g1').emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'toolu_a' });
    runOf('new-g1').end();
    await tick();
    expect(await awaiting()).toEqual([
      expect.objectContaining({ chatId: 'sess-new-g1', parentChatId: 'parent', kind: 'question' }),
    ]);

    registry.stopAll();
    await app.close();
    await boot();
    expect((await awaiting()).map((chat) => chat.chatId)).toEqual(['sess-new-g1']);
  });

  it('запрос прав: карточка с ключом прогона, решение из хаба доходит до брокера и снимает её', async () => {
    await startGroup('new-g2');
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: {
        runId: 'new-g2',
        toolName: 'Bash',
        input: { command: 'git push --force origin HEAD' },
        toolUseId: 'toolu_p',
      },
    });
    await tick();

    const waiting = await nodeOf('sess-new-g2');
    expect(waiting?.asks).toEqual([
      expect.objectContaining({ kind: 'permission', runId: 'new-g2', toolUseId: 'toolu_p' }),
    ]);
    expect(waiting?.status).toBe('waiting');

    const decided = await app.inject({
      method: 'POST',
      url: '/api/chat/new-g2/permission-decision',
      payload: { toolUseId: 'toolu_p', behavior: 'allow' },
    });
    expect(decided.json()).toEqual({ ok: true });
    expect((await pending).json()).toMatchObject({ behavior: 'allow' });
    await tick();
    const after = await nodeOf('sess-new-g2');
    expect(after?.asks).toBeUndefined();
    expect(after?.status).toBe('running');
  });

  it('вопрос одним текстом (журнал 97 g7): карточка с хвостом ответа; итог без вопроса карточки не даёт', async () => {
    await startGroup('new-g3');
    runOf('new-g3').emit({
      kind: 'text',
      text: 'PROJ-1193 не трогал: ведущий считает это поведением по замыслу.\n\nЧинить или закрыть как «не баг»?',
    });
    runOf('new-g3').end();
    await startGroup('new-g4');
    runOf('new-g4').emit({ kind: 'text', text: 'Готово, MR !825 обновлён.' });
    runOf('new-g4').end();
    await tick();

    const asked = await nodeOf('sess-new-g3');
    expect(asked?.asks).toEqual([
      expect.objectContaining({
        kind: 'text',
        text: expect.stringContaining('Чинить или закрыть'),
      }),
    ]);
    expect(asked?.status).toBe('waiting');
    const done = await nodeOf('sess-new-g4');
    expect(done?.asks).toBeUndefined();
    expect(done?.status).toBe('idle');
  });

  it('вопрос разговора вне дерева не записывается', async () => {
    registry.start(
      'solo',
      { prompt: 'просто чат', cwd: root, permissionPrompt: { runId: 'solo', baseUrl: 'http://x' } },
      { projectPath: root },
    );
    await tick();
    runOf('solo').emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'toolu_s' });
    runOf('solo').end();
    await tick();
    const file = join(data, PENDING_ASKS_FILE);
    const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown[]) : [];
    expect(saved).toEqual([]);
  });

  it('узлы несут состояние (журнал 89): идёт, стоит на паузе', async () => {
    await startGroup('new-g5');
    expect((await nodeOf('sess-new-g5'))?.status).toBe('running');
    await app.inject({ method: 'POST', url: '/api/chat/parent/tree/pause' });
    expect((await nodeOf('sess-new-g5'))?.status).toBe('paused');
  });
});
