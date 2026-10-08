import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import {
  AUTONOMOUS_ENV,
  AUTONOMOUS_PICK_MARKER,
  type ChatEscalationsView,
  type ChatGroupSettingsView,
} from '@agentdeck/contracts/chat-group-settings';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../../../domains/chat/ChatRunner/ChatRunner.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { sandboxRoot } from '../../../domains/chat/ChatArtifacts/ChatArtifacts.ts';
import { QUESTION_DENIED } from '../../../domains/chat/initiative/initiative.ts';
import { wireChatAutonomy } from '../../../bootstrap/chat-autonomy-wiring.ts';
import { wireGroupActivation } from '../../../bootstrap/group-activation-wiring/group-activation-wiring.ts';
import { writeChoice } from '../../../domains/groups/choice/choice.ts';
import { registerChatRoutes } from '../../chat-routes/chat-routes.ts';
import { registerChatGroupSettingsRoutes } from './group-settings-routes.ts';

/**
 * Группа и автономность чата поверх НАСТОЯЩИХ маршрутов отправки и прав и той
 * же сборки, что в `bootstrap/runtime/runtime.ts` (`wireChatAutonomy`). Подменён только
 * CLI: прогон, который называет сессию, шлёт то, что ему велит тест, и живёт до
 * `end`. Вопросы — с чем уйдёт прогон (метка в окружении), что брокер ответит на
 * вопрос агента и куда ляжет критическое замечание ребёнка.
 */
describe('группа и автономность чата — маршруты', () => {
  let root: string;
  let data: string;
  let work: string;
  let store: AppStore;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  let runs: { options: RunOptions; emit: (event: ChatEvent) => void; end: () => void }[];
  let broadcasts: string[][];
  const ROOT = 'new-root-chat';
  const KID = 'new-kid-chat';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-chat-autonomy-'));
    data = join(root, 'agentdeck');
    work = join(root, 'work');
    mkdirSync(data, { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(join(root, 'projects'), { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    runs = [];
    broadcasts = [];
    store = new AppStore(data);
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) =>
        new Promise<void>((resolve) => {
          const id = options.permissionPrompt?.runId ?? 'x';
          // Ветвление (правка сообщения): CLI с `--fork-session` называет НОВУЮ сессию.
          const session = options.fork
            ? `fork-${runs.length}`
            : (options.sessionId ?? `sess-${id}`);
          // Транскрипт, как положил бы CLI: продолжение маршрут подтверждает им.
          mkdirSync(join(root, 'projects', 'p'), { recursive: true });
          writeFileSync(
            join(root, 'projects', 'p', `${session}.jsonl`),
            `${JSON.stringify({ type: 'user', cwd: work, sessionId: session })}
`,
          );
          onEvent({ kind: 'session', sessionId: session, model: '', tools: 0 });
          runs.push({ options, emit: onEvent, end: resolve });
        }),
      stop: () => undefined,
    }));
    registry.setSessionListener((chatId, sessionId, from) =>
      store.linkChatSession(chatId, sessionId, from),
    );
    const autonomy = wireChatAutonomy({
      store,
      chatRuns: registry,
      say: (chatId, event) => registry.emitExternal(chatId, event),
      broadcast: (domains) => broadcasts.push(domains),
    });
    registry.setHandoffPlanner((finished) => {
      const keys = finished.sessionId ? [finished.chatId, finished.sessionId] : [finished.chatId];
      autonomy.finished(keys, finished.text);
      return undefined;
    });
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          appData: data,
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    // Как в `runtime.ts`: выбранную группу включает старт реестра.
    wireGroupActivation({
      store,
      paths: ctx.location.paths,
      backupDir: ctx.backupDir,
      chatRuns: registry,
    });
    app = Fastify();
    registerChatRoutes(app, ctx, registry, new ChatSession(registry, data));
    registerChatGroupSettingsRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    for (const id of [ROOT, KID]) rmSync(join(sandboxRoot(), id), { recursive: true, force: true });
  });

  const tick = (ms = 30) => new Promise((done) => setTimeout(done, ms));

  const send = async (chatId: string, resume?: { sessionId: string; fork?: boolean }) => {
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId, prompt: 'работай', projectPath: work, allowEdits: true, ...resume },
    });
    await tick();
    // Продолжение реестр может завести под прежним ключом прогона — берём последний.
    const run = resume
      ? runs.at(-1)
      : runs.findLast((item) => item.options.permissionPrompt?.runId === chatId);
    if (!run) throw new Error(`no run ${chatId}`);
    return run;
  };

  /** Как вкладка: ключ чата и, если прогон его знает, `sessionId` запросом. */
  const query = (sessionId?: string) => (sessionId ? `?sessionId=${sessionId}` : '');

  const view = async (chatId: string, sessionId?: string) =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/chat/${chatId}/group-settings${query(sessionId)}`,
      })
    ).json<ChatGroupSettingsView>();

  const put = (chatId: string, payload: Record<string, unknown>, sessionId?: string) =>
    app.inject({
      method: 'PUT',
      url: `/api/chat/${chatId}/group-settings${query(sessionId)}`,
      payload,
    });

  const ask = async (runId: string, input: unknown): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId, toolName: 'AskUserQuestion', input, toolUseId: 'toolu_q1' },
    });
    return response.json<{ message: string }>().message;
  };

  const QUESTION = {
    questions: [
      {
        question: 'Путь?',
        header: 'Путь',
        options: [{ label: 'Быстрый' }, { label: 'Надёжный (Recommended)' }],
      },
    ],
  };

  it('по умолчанию прогон автономен: метка в окружении, вопрос закрыт выбором', async () => {
    const run = await send(ROOT);
    expect(run.options.env?.[AUTONOMOUS_ENV]).toBe('1');
    const message = await ask(ROOT, QUESTION);
    expect(message).toContain(AUTONOMOUS_PICK_MARKER);
    expect(message).toContain('Надёжный (Recommended)');
    // Без рекомендации — человеку, как было.
    expect(await ask(ROOT, { questions: [{ question: 'Что?', options: [{ label: 'А' }] }] })).toBe(
      QUESTION_DENIED,
    );
    run.end();
  });

  it('выключенная галочка: метки нет, вопрос уходит человеку', async () => {
    expect((await put(ROOT, { autonomous: false })).statusCode).toBe(200);
    const run = await send(ROOT);
    expect(run.options.env ?? {}).not.toHaveProperty(AUTONOMOUS_ENV);
    expect(await ask(ROOT, QUESTION)).toBe(QUESTION_DENIED);
    run.end();
  });

  it('ребёнок наследует от родителя; своё у ребёнка не трогает родителя', async () => {
    store.setChatLink(KID, { parentChatId: ROOT, createdAt: '2026-09-26T00:00:00Z' });
    await put(ROOT, { groupChoice: 'global:g1', autonomous: false });
    expect(await view(KID)).toEqual({
      groupChoice: 'global:g1',
      groupChoiceInherited: true,
      autonomous: false,
      autonomousInherited: true,
      parentChatId: ROOT,
    });
    await put(KID, { autonomous: true });
    expect((await view(KID)).autonomous).toBe(true);
    expect((await view(KID)).autonomousInherited).toBe(false);
    expect((await view(ROOT)).autonomous).toBe(false);
    // Пустое тело снимает своё — снова от родителя.
    await put(KID, {});
    expect((await view(KID)).autonomousInherited).toBe(true);
  });

  /**
   * Ревью 28.09 (F-111): правка сообщения ветвит разговор (`--fork-session`), и
   * CLI называет НОВУЮ сессию. Запись раньше ПЕРЕЕЗЖАЛА на ветку, а синоним
   * оставался одноуровневым: чтение по первому написанию (`new-…`) теряло
   * выключенную автономию, а исходный разговор и ветка делили одну запись.
   */
  describe('ветвление правкой сообщения (F-111)', () => {
    const FIRST = `sess-${ROOT}`;

    it('вкладка на настоящем id: ветка получает копию, исходный разговор — своё', async () => {
      await put(ROOT, { autonomous: false });
      (await send(ROOT)).end();
      await tick();
      (await send(FIRST, { sessionId: FIRST, fork: true })).end();
      await tick();
      const fork = 'fork-1';

      expect((await view(ROOT)).autonomous).toBe(false);
      expect((await view(FIRST)).autonomous).toBe(false);
      expect(await view(fork)).toMatchObject({ autonomous: false, autonomousInherited: false });

      // Своя запись у ветки: галочка в ней не трогает исходный разговор.
      await put(fork, { autonomous: true });
      expect((await view(fork)).autonomous).toBe(true);
      expect((await view(FIRST)).autonomous).toBe(false);
      expect((await view(ROOT)).autonomous).toBe(false);
    });

    it('вкладка ещё на `new-…`: пишет в ветку, дети по `new-…` видят исходный разговор', async () => {
      await put(ROOT, { autonomous: false, groupChoice: 'global:g1' });
      (await send(ROOT)).end();
      await tick();
      const run = await send(ROOT, { sessionId: FIRST, fork: true });
      const fork = 'fork-1';
      // Ход ветки идёт с выключенной автономией исходного разговора.
      expect(run.options.env ?? {}).not.toHaveProperty(AUTONOMOUS_ENV);
      run.end();
      await tick();

      expect(await view(fork)).toMatchObject({ autonomous: false, groupChoice: 'global:g1' });
      expect(await view(ROOT, fork)).toMatchObject({ autonomous: false, groupChoice: 'global:g1' });
      // Вкладка шлёт ключ и `sessionId` прогона — правка ложится на ветку.
      await put(ROOT, { autonomous: true }, fork);
      expect((await view(ROOT, fork)).autonomous).toBe(true);
      expect((await view(fork)).autonomous).toBe(true);
      // Исходный разговор и те, кто знает его по `new-…` (дети разделения), — при своём.
      expect((await view(FIRST)).autonomous).toBe(false);
      expect((await view(ROOT)).autonomous).toBe(false);

      // Следующие ходы: ветка — автономно, исходный разговор — нет.
      const forkTurn = await send(fork, { sessionId: fork });
      expect(forkTurn.options.env?.[AUTONOMOUS_ENV]).toBe('1');
      forkTurn.end();
      await tick();
      const firstTurn = await send(FIRST, { sessionId: FIRST });
      expect(firstTurn.options.env ?? {}).not.toHaveProperty(AUTONOMOUS_ENV);
      firstTurn.end();
    });
  });

  /**
   * Ревью 28.09 (F-107): из пары «проектная — её глобальная копия» в проекте
   * действует одна сторона. Меню чата прячет другую, но запрос в обход меню
   * (старая вкладка, телефон, скрипт) закреплял её — и прогон шёл по шагам
   * группы, которой в проекте нет, а глобальная копия включалась поверх
   * проектной. Сервер отказывает сам, кодом.
   */
  describe('неактивная сторона пары (F-107)', () => {
    const pairGroup = (id: string, patch: Partial<Group>): Group => ({
      id,
      name: id,
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      projectPaths: [],
      isEnabled: false,
      order: 0,
      ...patch,
    });
    const pair = (): void => {
      store.saveGroup(
        pairGroup('pa', { scope: { kind: 'project', path: work, provider: 'claude' } }),
      );
      store.saveGroup(
        pairGroup('ga', {
          origin: {
            scope: { kind: 'project', path: work, provider: 'claude' },
            groupId: 'pa',
            hash: 'h',
            copiedAt: '2026-09-28T00:00:00.000Z',
          },
        }),
      );
    };
    const refused = (response: Awaited<ReturnType<typeof put>>) => {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'group_pair_inactive_side',
        messageCode: 'chat-group-pair-inactive-side',
        params: { group: 'ga' },
      });
    };

    it('проект чата — из его транскрипта: закрепить неактивную сторону нельзя', async () => {
      pair();
      (await send(ROOT)).end();
      await tick();
      refused(await put(ROOT, { groupChoice: 'global:ga' }, `sess-${ROOT}`));
      expect((await view(ROOT, `sess-${ROOT}`)).groupChoice).toBe('auto');
      // Действующая сторона — пожалуйста.
      expect((await put(ROOT, { groupChoice: 'project:pa' }, `sess-${ROOT}`)).statusCode).toBe(200);
    });

    it('черновик без транскрипта — по проекту вкладки; выбор пары меняет сторону', async () => {
      pair();
      const draft = (payload: Record<string, unknown>) =>
        app.inject({
          method: 'PUT',
          url: `/api/chat/${ROOT}/group-settings?projectPath=${encodeURIComponent(work)}`,
          payload,
        });
      refused(await draft({ groupChoice: 'global:ga' }));
      writeChoice(data, store.getGroups(), work, 'global:ga');
      expect((await draft({ groupChoice: 'global:ga' })).statusCode).toBe(200);
      const project = await draft({ groupChoice: 'project:pa' });
      expect(project.statusCode).toBe(409);
      expect(project.json()).toMatchObject({ params: { group: 'pa' } });
    });

    it('закреплённая раньше сторона не мешает галочке автономии', async () => {
      pair();
      store.setChatGroupSettings(ROOT, { groupChoice: 'global:ga' });
      const response = await app.inject({
        method: 'PUT',
        url: `/api/chat/${ROOT}/group-settings?projectPath=${encodeURIComponent(work)}`,
        payload: { groupChoice: 'global:ga', autonomous: false },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<ChatGroupSettingsView>().autonomous).toBe(false);
    });
  });

  it('кривое тело — 400 с полем', async () => {
    const response = await put(ROOT, { groupChoice: 'не-ключ', autonomous: 'да' });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_body');
  });

  it('явно выбранная группа включается к старту прогона', async () => {
    const group: Group = {
      id: 'g1',
      name: 'Набор',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      projectPaths: [],
      isEnabled: false,
      order: 0,
    };
    store.saveGroup(group);
    await put(ROOT, { groupChoice: 'global:g1' });
    const run = await send(ROOT);
    expect(store.getGroups()[0]?.isEnabled).toBe(true);
    run.end();
  });

  it('критическое замечание ребёнка — в главный чат, с отметкой прочтения', async () => {
    store.setChatLink(KID, {
      parentChatId: ROOT,
      title: 'Правка API',
      createdAt: '2026-09-26T00:00:00Z',
    });
    const run = await send(KID);
    run.emit({
      kind: 'text',
      text: 'Готово.\n```agentdeck:escalate\n{"severity":"critical","text":"ключ в логах"}\n```',
    });
    run.end();
    await tick();

    const list = (
      await app.inject({ method: 'GET', url: '/api/chat/escalations' })
    ).json<ChatEscalationsView>();
    expect(list.chats[ROOT]).toEqual([
      expect.objectContaining({
        childChatId: `sess-${KID}`,
        childTitle: 'Правка API',
        text: 'ключ в логах',
        source: 'block',
        read: false,
      }),
    ]);
    expect(broadcasts).toContainEqual(['chat-escalations']);

    await app.inject({ method: 'POST', url: `/api/chat/${ROOT}/escalations/read` });
    const after = (
      await app.inject({ method: 'GET', url: '/api/chat/escalations' })
    ).json<ChatEscalationsView>();
    expect(after.chats[ROOT]?.[0]?.read).toBe(true);
  });
});
