import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { registerChatTranscriptRoutes } from './chat/transcript-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { copyRootOf, SplitConveyor } from '../domains/chat/split-conveyor.ts';
import { createSplitLauncher, launchFromRecord } from './chat/split-launch.ts';
import type { ChatLink } from '../lib/app-store/app-store.types.ts';
import {
  GROUP_QUESTIONS_HUMAN_LINE,
  SPLIT_BLOCK_LANG,
  scanSplitBlocks,
} from '@agentdeck/contracts/task-split';
import { SPLIT_DEFAULTS_BUILTIN } from '@agentdeck/contracts/split-groups';

/**
 * Маршрут разделения задач по чатам. Каталог берём обычный (не репозиторий) —
 * тогда проверяется именно склейка «маршрут → домен → реестр прогонов», без
 * настоящего git: копии заводятся его собственным тестом.
 */
describe('POST /api/chat/split', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let ctx: ServerContext;
  let started: {
    chatId: string;
    prompt: string;
    cwd: string;
    appendSystemPrompt?: string;
    /** Чем прогон реально стартовал: подбор модели проверяется только здесь. */
    model?: string;
    effort?: string;
    permissionMode?: string;
    /** Родитель, известный хранилищу В МОМЕНТ запуска, — см. тест про гонку. */
    parentAtStart?: string;
  }[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-'));
    project = mkdtempSync(join(tmpdir(), 'cc-split-proj-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });

    started = [];
    // Прогон-заглушка: запоминает запуск и немедленно завершается, чтобы реестр
    // не держал висящих процессов между тестами.
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        const chatId = options.permissionPrompt?.runId ?? '';
        started.push({
          chatId,
          prompt: options.prompt,
          cwd: options.cwd,
          ...(options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
          ...(store.getChatLink(chatId)?.parentChatId
            ? { parentAtStart: store.getChatLink(chatId)?.parentChatId }
            : {}),
        });
      },
      stop: () => undefined,
    }));

    store = new AppStore(join(root, 'agentdeck'));
    ctx = {
      location: {
        paths: {
          root,
          appData: join(root, 'agentdeck'),
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;

    app = Fastify();
    session = new ChatSession(registry);
    registerChatSplitRoutes(app, ctx, {
      runs: registry,
      providerChats: new ProviderChatService(),
      session,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const proposal = {
    shared: 'Общее',
    groups: [
      { title: 'Раз', branch: 'feature/one', tasks: ['первая задача'] },
      { title: 'Два', branch: 'feature/two', tasks: ['вторая задача'] },
    ],
  };

  it('заводит по чату на группу и запускает прогоны', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { chats: { started: boolean; path: string }[] };
    expect(body.chats).toHaveLength(2);
    expect(body.chats.every((chat) => chat.started)).toBe(true);
    expect(started).toHaveLength(2);
    expect(started[0]?.prompt).toContain('первая задача');
    expect(started[0]?.prompt).toContain('Общее');
  });

  // Аудит 25.09, L40: общая строка «развилки решает человек» доезжает до групп.
  it('развилки у человека во вкладке «Группы» — строка вопросов в задании группы', async () => {
    store.setSplitDefaults({ ...structuredClone(SPLIT_DEFAULTS_BUILTIN), groupQuestions: 'human' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });
    expect(response.statusCode).toBe(200);
    expect(started[0]?.prompt).toContain(GROUP_QUESTIONS_HUMAN_LINE);
  });

  it('группы с правками идут в авторежиме прав, без правок — спрашивают', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true, allowEdits: true },
    });
    expect(response.statusCode).toBe(200);
    expect(started.map((run) => run.permissionMode)).toEqual(['auto', 'auto']);

    started.length = 0;
    await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });
    expect(started.map((run) => run.permissionMode)).toEqual(['default', 'default']);
  });

  // Д1 (инцидент 23.09): веб шлёт предложение, уже разобранное общим сканером,
  // и сервер разбирает его второй раз. Работа в MR доезжала до ребёнка ревью.
  it('работа в MR с телом веба доезжает до ребёнка работой, а не ревью', async () => {
    const block = JSON.stringify({
      groups: [
        {
          title: '!773',
          tasks: ['поправь по замечаниям, закоммить и запушь'],
          review: { url: 'https://gitlab.com/team/app/-/merge_requests/773', action: 'work' },
        },
        {
          title: '!772',
          tasks: ['поправь по замечаниям'],
          review: { url: 'https://gitlab.com/team/app/-/merge_requests/772', action: 'work' },
        },
      ],
    });
    const web = scanSplitBlocks('```' + SPLIT_BLOCK_LANG + '\n' + block + '\n```').proposals[0];
    expect(web?.groups).toHaveLength(2);

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal: web, startRuns: true },
    });

    expect(response.statusCode).toBe(200);
    expect(started).toHaveLength(2);
    for (const run of started) {
      expect(run.prompt).toContain('работает в запросе на слияние');
      expect(run.prompt).not.toContain('НИЧЕГО НЕ ПРАВЬ');
    }
  });

  it('набор, привязанный к проекту, включается и для порождённых чатов', async () => {
    // Прогон здесь заводит не отправка из поля ввода, а сам маршрут: без этого
    // правила и скиллы набора доехали бы только со следующего сообщения,
    // набранного руками, — то есть агент стартовал бы не с тем окружением.
    store.saveGroup({
      id: 'набор',
      name: 'Набор проекта',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      isEnabled: false,
      order: 0,
      projectPaths: [project],
    });

    await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });

    expect(store.getGroups()[0]?.isEnabled).toBe(true);
  });

  it('автоподтверждение прав наследуется от родителя', async () => {
    // Ради этого и делят: шесть агентов работают сами. Без наследования каждый
    // встал бы на первом же инструменте, ожидая человека, который смотрит в
    // другую вкладку.
    registry.start('parent', { prompt: 'задача', cwd: project }, {});
    session.armAutoApprove('parent', { enabled: true, allowEdits: true });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true, parentChatId: 'parent' },
    });

    const body = response.json() as { chats: { chatId: string }[] };
    // Помечен унаследованным: строки вкладки «Группы» ему не уступают (M3).
    for (const chat of body.chats) {
      expect(session.autoApproveFor(chat.chatId)).toEqual({
        enabled: true,
        allowEdits: true,
        inherited: true,
      });
    }
  });

  it('родитель без автоподтверждения ничего детям не навязывает', async () => {
    registry.start('parent', { prompt: 'задача', cwd: project }, {});

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true, parentChatId: 'parent' },
    });

    const body = response.json() as { chats: { chatId: string }[] };
    for (const chat of body.chats) expect(session.autoApproveFor(chat.chatId)).toBeUndefined();
  });

  /**
   * Связь с родителем обязана лежать в хранилище УЖЕ на запуске прогона.
   *
   * Прогон называет настоящий `sessionId` через пару секунд после старта, и
   * перенос связи на него ищет запись по временному ключу: не найдя — молча
   * ничего не делает. Пока связи писались после всего разделения, копия большого
   * репозитория заводилась дольше, чем стартовал предыдущий CLI, и родство
   * доставалось только последней группе (живое разделение 3 сентября: четыре
   * ветки, дерево — у одной).
   */
  it('связь с родителем записана до запуска прогона, а не после разделения', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true, parentChatId: 'parent' },
    });

    expect(started).toHaveLength(2);
    for (const run of started) expect(run.parentAtStart).toBe('parent');
  });

  // Живой прогон 25.09 (F5): второй план того же разговора вклеивал в свои
  // строки чаты прошлого — по тому же номеру группы у того же родителя.
  it('новое разделение снимает звенья прошлого плана того же разговора', async () => {
    const split = async () =>
      (
        (
          await app.inject({
            method: 'POST',
            url: '/api/chat/split',
            payload: { projectPath: project, proposal, startRuns: true, parentChatId: 'parent' },
          })
        ).json() as { chats: { chatId: string }[] }
      ).chats.map((chat) => chat.chatId);
    // Прошлый чат группы успел назвать настоящую сессию — у связи два ключа.
    const first = await split();
    const firstLink = store.getChatLink(first[0] ?? '');
    if (firstLink) store.setChatLink('old-session', { ...firstLink, conversation: first[0] });

    const second = await split();

    expect(first).toHaveLength(2);
    for (const chatId of [...first, 'old-session']) {
      expect(store.getChatLink(chatId)).toBeUndefined();
      expect(store.getRetiredChatLinks()[chatId]?.parentChatId).toBe('parent');
    }
    for (const chatId of second) {
      expect(store.getChatLink(chatId)).toMatchObject({ parentChatId: 'parent' });
    }
  });

  it('без родителя связей не заводим — разделение бывает и без разговора', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });

    const body = response.json() as { chats: { chatId: string }[] };
    for (const chat of body.chats) expect(store.getChatLink(chat.chatId)).toBeUndefined();
  });

  it('«только завести чаты» не запускает ни одного прогона', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: false },
    });

    expect(response.statusCode).toBe(200);
    expect(started).toHaveLength(0);
    const body = response.json() as { chats: { prompt: string }[] };
    expect(body.chats[0]?.prompt).toContain('первая задача');
  });

  it('без каталога проекта — отказ, а не чаты неизвестно где', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { proposal, startRuns: true },
    });

    expect(response.statusCode).toBe(400);
  });

  it('предложение из одной группы — отказ: это не разделение', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: {
        projectPath: project,
        proposal: { groups: [{ title: 'Одна', branch: 'a', tasks: ['x'] }] },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(started).toHaveLength(0);
  });

  it('порождённый чат получает продолжение, но делиться дальше не предлагает', async () => {
    // Чат, только что выделенный под ОДНУ группу, уже разделён: предлагать ему
    // дробиться снова значит спрашивать то же самое по второму разу, и сразу в
    // шести местах — так живые прогоны и вышли. Продолжение в чистой сессии —
    // другое решение и другой тумблер, его человек включал отдельно, и молча
    // отключаться во всех порождённых чатах оно не должно.
    await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });

    const appended = started[0]?.appendSystemPrompt ?? '';
    expect(appended).not.toContain('agentdeck:split');
    expect(appended).toContain('agentdeck:handoff');
    // Одна строка: перевод строки внутри аргумента рвёт командную строку cmd.exe.
    expect(appended).not.toMatch(/[\r\n]/);
  });

  it('выключенная инициатива в порождённый чат не уходит', async () => {
    // Разделение здесь и так молчит, продолжение выключено тумблером — из
    // склейки остаётся только правило про вопрос человеку, у которого тумблера
    // нет и быть не должно.
    store.updateSettings({ handoffInitiative: false });

    await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });

    const appended = started[0]?.appendSystemPrompt ?? '';
    expect(appended).not.toContain('agentdeck:split');
    expect(appended).not.toContain('agentdeck:handoff');
    expect(appended).toContain('AskUserQuestion');
  });

  /**
   * Отказ «работаем здесь» гасит инициативу и в РОДИТЕЛЬСКОМ разговоре: реплика
   * отказа живёт один ход, а инструкция дописывается к каждому прогону.
   */
  it('отказ от разделения помечает разговор', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split/decline',
      payload: { chatId: 'chat-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(registry.isSplitMuted('chat-1')).toBe(true);
    expect(registry.isSplitMuted('chat-2')).toBe(false);
  });

  it('текст просьбы отдаётся сервером — второй копии инструкции в клиенте нет', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/chat/split/request' });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { prompt: string }).prompt).toContain('agentdeck:split');
  });

  /**
   * Подбор модели под задачу. Проверяем не таблицу классов (у неё свои юниты), а
   * склейку: доезжает ли назначение до аргументов прогона, до связи чата и до
   * ответа — три места, которые обязаны говорить одно и то же.
   */
  describe('подбор модели под задачу', () => {
    /** Потолок задаётся шапкой разговора — как это и делает панель. */
    const ceiling = { model: 'claude-opus-5', effort: 'high' };
    const kinds = {
      shared: 'Общее',
      groups: [
        { title: 'Раз', branch: 'feature/one', tasks: ['переименовать поле'], kind: 'mechanical' },
        { title: 'Два', branch: 'feature/two', tasks: ['почему падает'], kind: 'investigation' },
      ],
    };

    it('механика едет ниже потолка, разбор — на потолке', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: { projectPath: project, proposal: kinds, startRuns: true, ...ceiling },
      });

      expect(response.statusCode).toBe(200);
      expect(started[0]?.model).toBe('sonnet');
      expect(started[1]?.model).toBe('claude-opus-5');
      // Понижение оплачивается проверкой: работе слабее потолка дописывается
      // планка сдачи, работе на потолке — нет, усиливать нечем.
      expect(started[0]?.appendSystemPrompt).toContain('НИЖЕ потолка');
      expect(started[1]?.appendSystemPrompt).not.toContain('НИЖЕ потолка');

      const body = response.json() as { chats: { model?: string; kind?: string }[] };
      expect(body.chats[0]).toMatchObject({ model: 'sonnet', kind: 'mechanical' });
    });

    it('замена человека сильнее подбора и действует ВНИЗ', async () => {
      // `haiku` подбор не назначает никогда сам — только человек, видевший
      // задачи группы. Класс при этом остаётся распознанным.
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal: kinds,
          startRuns: true,
          ...ceiling,
          assignments: { 0: { model: 'haiku', effort: 'low' } },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(started[0]?.model).toBe('haiku');
      expect(started[0]?.effort).toBe('low');
      const body = response.json() as { chats: { model?: string; kind?: string }[] };
      expect(body.chats[0]).toMatchObject({ model: 'haiku', kind: 'mechanical' });
    });

    it('замена выше потолка срезается до потолка', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal: kinds,
          startRuns: true,
          ...ceiling,
          assignments: { 0: { model: 'fable', effort: 'xhigh' } },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(started[0]?.model).toBe('claude-opus-5');
      expect(started[0]?.effort).toBe('high');
    });

    it('связь чата помнит назначение — второе сообщение не теряет модель', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal: kinds,
          startRuns: true,
          parentChatId: 'parent-1',
          ...ceiling,
        },
      });

      const link = store.getChatLink(started[0]?.chatId ?? '');
      expect(link).toMatchObject({ model: 'sonnet', kind: 'mechanical', lowered: true });
    });

    it('выключенное в проекте правило возвращает прежнее поведение', async () => {
      store.setProjectCascade(project, false);

      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: { projectPath: project, proposal: kinds, startRuns: true, ...ceiling },
      });

      expect(response.statusCode).toBe(200);
      // Оба ребёнка — на выбранной человеком модели, без пометок и без класса.
      expect(started.map((run) => run.model)).toEqual(['claude-opus-5', 'claude-opus-5']);
      expect(started[0]?.appendSystemPrompt).not.toContain('НИЖЕ потолка');
      const body = response.json() as { chats: { model?: string; kind?: string }[] };
      expect(body.chats[0]?.model).toBeUndefined();
      expect(body.chats[0]?.kind).toBeUndefined();
    });

    it('просьба «раздели задачи» несёт классы только там, где правило действует', async () => {
      const on = await app.inject({
        method: 'GET',
        url: `/api/chat/split/request?path=${encodeURIComponent(project)}&model=claude-opus-5`,
      });
      expect((on.json() as { prompt: string }).prompt).toContain('kind');

      store.setProjectCascade(project, false);
      const off = await app.inject({
        method: 'GET',
        url: `/api/chat/split/request?path=${encodeURIComponent(project)}&model=claude-opus-5`,
      });
      const prompt = (off.json() as { prompt: string }).prompt;
      expect(prompt).toContain('agentdeck:split');
      expect(prompt).not.toContain('mechanical');
    });
  });

  /**
   * Уровни (Т1): подбор включён, родитель известен, прогоны нужны — маршрут не
   * заводит ни одной копии, а запускает разбор в корне и отдаёт его чат. Группы
   * заводит конвейер по итогу разбора; здесь проверяется только склейка
   * «маршрут → конвейер → лаунчер»: что стартовало и что записано.
   */
  describe('уровни разделения при включённом подборе', () => {
    const ceiling = { model: 'claude-opus-5', effort: 'high' };
    const kinds = {
      shared: 'Общее',
      groups: [
        { title: 'Раз', branch: 'feature/one', tasks: ['переименовать поле'], kind: 'mechanical' },
        { title: 'Два', branch: 'feature/two', tasks: ['почему падает'], kind: 'investigation' },
      ],
    };

    function withConveyor(): SplitConveyor {
      const conveyor = new SplitConveyor({
        store: {
          get: (parent) => store.getSplitPlan(parent),
          set: (record) => store.setSplitPlan(record),
          findByTriage: (ids) => store.findSplitPlanByTriage(ids),
          all: () => store.getSplitPlans(),
        },
        launch: (record, groups, context) =>
          launchFromRecord(ctx, launchDeps(), record, groups, context),
        startTriage: (record, prompt) =>
          // Как в `runtime.ts`: разбор — в верхе репозитория, настройки — по пути проекта.
          createSplitLauncher(ctx, launchDeps(), {
            projectPath: copyRootOf(record),
            settingsPath: record.projectPath,
            parentChatId: record.parentChatId,
            ...(record.request.model ? { model: record.request.model } : {}),
            ...(record.request.effort ? { effort: record.request.effort } : {}),
          }).startTriage(prompt),
        log: () => undefined,
      });
      return conveyor;
    }

    function launchDeps() {
      return {
        runs: registry,
        providerChats: new ProviderChatService(),
        session,
        log: { warn: () => undefined },
      };
    }

    async function withRoutes(conveyor: SplitConveyor): Promise<FastifyInstance> {
      const instance = Fastify();
      registerChatSplitRoutes(instance, ctx, { ...launchDeps(), conveyor });
      await instance.ready();
      return instance;
    }

    it('сначала разбор в корне на потолке; копий и групп ещё нет', async () => {
      const conveyor = withConveyor();
      const instance = await withRoutes(conveyor);

      const response = await instance.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal,
          startRuns: true,
          parentChatId: 'parent-1',
          ...ceiling,
        },
      });
      await instance.close();

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        chats: unknown[];
        triage?: { chatId: string; started: boolean };
      };
      expect(body.chats).toEqual([]);
      expect(body.triage?.started).toBe(true);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        chatId: body.triage?.chatId,
        cwd: project,
        model: 'claude-opus-5',
        effort: 'high',
        // Человека у разбора нет: при default каждый `cd … && grep` ждал кнопки (живой прогон 24.09).
        permissionMode: 'auto',
      });
      expect(started[0]?.prompt).toContain('разбор разделения');
      expect(started[0]?.prompt).toContain('agentdeck:split-plan');
      // Связь разбора — под родителем, со стадией; запись конвейера — под родителем.
      expect(store.getChatLink(body.triage?.chatId ?? '')).toMatchObject({
        parentChatId: 'parent-1',
        stage: 'triage',
        title: 'Разбор разделения',
      });
      expect(store.getSplitPlan('parent-1')?.groups.map((group) => group.status)).toEqual([
        'pending',
        'pending',
      ]);
    });

    it('по итогу разбора группы стартуют со звена плана на потолке, границы — в связи', async () => {
      const conveyor = withConveyor();
      const instance = await withRoutes(conveyor);
      const first = await instance.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal: kinds,
          startRuns: true,
          parentChatId: 'parent-1',
          ...ceiling,
        },
      });
      await instance.close();
      const triageId = (first.json() as { triage: { chatId: string } }).triage.chatId;
      started.length = 0;

      const block = [
        '```agentdeck:split-plan',
        JSON.stringify({
          groups: [
            { index: 1, owns: ['src/rename.ts'], notes: 'api.ts не трогать' },
            { index: 2, after: [1] },
          ],
          order: [1, 2],
        }),
        '```',
      ].join('\n');
      const event = conveyor.onTriageFinished(
        {
          chatId: triageId,
          projectPath: project,
          text: `Развёл.\n${block}`,
          ok: true,
          startedAt: 1,
          options: { prompt: '', cwd: project },
          contextTokens: 0,
        },
        [triageId],
      );
      await new Promise((done) => setTimeout(done, 30));

      expect(event).toMatchObject({ kind: 'notice', code: 'triageApplied' });
      // Стартовала только первая группа; вторая ждёт её цепочки.
      expect(started).toHaveLength(1);
      expect(started[0]?.prompt).toContain('План работы для группы «Раз»');
      expect(started[0]?.prompt).toContain('src/rename.ts');
      // План — на потолке, хотя работа механики пойдёт ниже.
      expect(started[0]?.model).toBe('claude-opus-5');
      expect(store.getChatLink(started[0]?.chatId ?? '')).toMatchObject({
        stage: 'plan',
        model: 'claude-opus-5',
        workModel: 'sonnet',
        lowered: true,
        owns: ['src/rename.ts'],
        notes: 'api.ts не трогать',
      });
      const record = store.getSplitPlan('parent-1');
      expect(record?.groups.map((group) => group.status)).toEqual(['started', 'waiting']);

      // Цепочка первой кончилась — вторая стартует с заметкой о предшественнике.
      conveyor.onChainEnded(store.getChatLink(started[0]?.chatId ?? '') as ChatLink, {
        status: 'done',
      });
      await new Promise((done) => setTimeout(done, 30));
      expect(started).toHaveLength(2);
      expect(store.getChatLink(started[1]?.chatId ?? '')?.notes).toContain(
        'Раньше этой группы работали: «Раз»',
      );
    });

    /**
     * Группа, ждущая предшественника, чья цепочка не кончится никогда
     * (остановлен, чат удалён): до 18.09.2026 сдвинуть её было нечем — ответ на
     * вопрос разбора работает только со статусом `held`. Здесь пройден весь
     * путь: маршрут разделения → разбор с `after` → маршрут «отпустить».
     */
    it('ждущую группу отпускает маршрут родителя — с прямым словом об этом в задании', async () => {
      const conveyor = withConveyor();
      const instance = await withRoutes(conveyor);
      const first = await instance.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal: kinds,
          startRuns: true,
          parentChatId: 'parent-1',
          ...ceiling,
        },
      });
      const triageId = (first.json() as { triage: { chatId: string } }).triage.chatId;
      const block = [
        '```agentdeck:split-plan',
        JSON.stringify({ groups: [{ index: 2, after: [1] }], order: [1, 2] }),
        '```',
      ].join('\n');
      conveyor.onTriageFinished(
        {
          chatId: triageId,
          projectPath: project,
          text: block,
          ok: true,
          startedAt: 1,
          options: { prompt: '', cwd: project },
          contextTokens: 0,
        },
        [triageId],
      );
      await new Promise((done) => setTimeout(done, 30));
      started.length = 0;
      expect(store.getSplitPlan('parent-1')?.groups[1]?.status).toBe('waiting');

      // Уже работающую отпускать нечего.
      const refused = await instance.inject({
        method: 'POST',
        url: '/api/chat/split/parent-1/release',
        payload: { index: 0 },
      });
      expect(refused.statusCode).toBe(409);

      const released = await instance.inject({
        method: 'POST',
        url: '/api/chat/split/parent-1/release',
        payload: { index: 1 },
      });
      await instance.close();

      expect(released.statusCode).toBe(200);
      expect(
        (released.json() as { chats: { index: number }[] }).chats.map((chat) => chat.index),
      ).toEqual([1]);
      expect(started).toHaveLength(1);
      // Агент узнаёт из задания и базу, и то, что работа предшественника не легла.
      expect(started[0]?.prompt).toContain('цепочка НЕ кончилась');
      expect(store.getChatLink(started[0]?.chatId ?? '')?.notes).toContain('цепочка НЕ кончилась');
      expect(store.getSplitPlan('parent-1')?.groups[1]).toMatchObject({
        released: true,
        status: 'started',
      });
    });

    it('ответ на вопрос разбора — маршрутом родителя; без вопроса — 409', async () => {
      const conveyor = withConveyor();
      const instance = await withRoutes(conveyor);
      const first = await instance.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal,
          startRuns: true,
          parentChatId: 'parent-1',
          ...ceiling,
        },
      });
      const triageId = (first.json() as { triage: { chatId: string } }).triage.chatId;
      const block = [
        '```agentdeck:split-plan',
        JSON.stringify({ groups: [{ index: 2, hold: 'какой стиль?' }] }),
        '```',
      ].join('\n');
      conveyor.onTriageFinished(
        {
          chatId: triageId,
          projectPath: project,
          text: block,
          ok: true,
          startedAt: 1,
          options: { prompt: '', cwd: project },
          contextTokens: 0,
        },
        [triageId],
      );
      await new Promise((done) => setTimeout(done, 30));
      started.length = 0;

      const refused = await instance.inject({
        method: 'POST',
        url: '/api/chat/split/parent-1/hold',
        payload: { index: 0, answer: 'x' },
      });
      expect(refused.statusCode).toBe(409);
      const empty = await instance.inject({
        method: 'POST',
        url: '/api/chat/split/parent-1/hold',
        payload: { index: 1, answer: '  ' },
      });
      expect(empty.statusCode).toBe(400);

      const answered = await instance.inject({
        method: 'POST',
        url: '/api/chat/split/parent-1/hold',
        payload: { index: 1, answer: 'как в шапке' },
      });
      await instance.close();
      expect(answered.statusCode).toBe(200);
      expect(
        (answered.json() as { chats: { index: number }[] }).chats.map((chat) => chat.index),
      ).toEqual([1]);
      expect(started).toHaveLength(1);
      expect(started[0]?.prompt).toContain('Ответ человека: как в шапке');
      expect(store.getSplitPlan('parent-1')?.groups[1]).toMatchObject({
        status: 'started',
        holdAnswer: 'как в шапке',
      });
    });

    /**
     * Разбор, оборванный перезапуском панели. Раньше это морозило разделение
     * навсегда: итог применяет ровно один вызов — завершение прогона разбора,
     * а он после перезапуска не приедет уже никогда. Дверь человека (ответ на
     * вопрос) отвечала 409 — группы не `held`. Здесь пройдена та же дорога:
     * маршрут → перезапуск (новый конвейер поверх ТОГО ЖЕ хранилища, прогона
     * больше нет) → сверка на старте → маршрут ответа.
     */
    it('разбор оборван перезапуском — дверь человека открыта, копии сами не идут', async () => {
      const instance = await withRoutes(withConveyor());
      const first = await instance.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal,
          startRuns: true,
          parentChatId: 'parent-1',
          ...ceiling,
        },
      });
      expect((first.json() as { chats: unknown[] }).chats).toEqual([]);
      await instance.close();
      started.length = 0;

      // Перезапуск: память процесса пуста, на диске — та же запись разделения.
      const revived = withConveyor();
      const notices = revived.recoverInterruptedTriage(() => false);
      const instance2 = await withRoutes(revived);

      expect(notices).toHaveLength(1);
      // Ни одной копии само по себе: решение за человеком, а не за панелью.
      expect(started).toEqual([]);
      expect(store.getSplitPlan('parent-1')?.groups.map((group) => group.status)).toEqual([
        'held',
        'held',
      ]);

      const answered = await instance2.inject({
        method: 'POST',
        url: '/api/chat/split/parent-1/hold',
        payload: { index: 0, answer: 'да, запускай' },
      });
      await instance2.close();

      expect(answered.statusCode).toBe(200);
      expect(started).toHaveLength(1);
      expect(store.getSplitPlan('parent-1')?.groups[0]?.status).toBe('started');
    });

    it('«только завести чаты» и выключенное правило идут старым путём — без разбора', async () => {
      const instance = await withRoutes(withConveyor());

      const drafts = await instance.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal,
          startRuns: false,
          parentChatId: 'parent-1',
          ...ceiling,
        },
      });
      expect((drafts.json() as { chats: unknown[]; triage?: unknown }).chats).toHaveLength(2);
      expect((drafts.json() as { triage?: unknown }).triage).toBeUndefined();

      store.setProjectCascade(project, false);
      const off = await instance.inject({
        method: 'POST',
        url: '/api/chat/split',
        payload: {
          projectPath: project,
          proposal,
          startRuns: true,
          parentChatId: 'parent-2',
          ...ceiling,
        },
      });
      await instance.close();
      expect(
        (off.json() as { chats: { started: boolean }[] }).chats.map((chat) => chat.started),
      ).toEqual([true, true]);
      expect(store.getSplitPlan('parent-2')).toBeUndefined();
    });

    /**
     * Живой прогон 24.09.2026: агент родителя ушёл `cd` в подкаталог, путь чата
     * уехал в разделение, и восемь групп стартовали в ОДНОМ подкаталоге без копий.
     */
    describe('путь разделения из подкаталога репозитория', () => {
      let sub: string;

      beforeEach(() => {
        const run = (...args: string[]) =>
          execFileSync('git', args, { cwd: project, stdio: 'ignore' });
        run('init', '-b', 'main');
        run('config', 'user.email', 't@t');
        run('config', 'user.name', 't');
        sub = join(project, 'app', 'src');
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, 'a.ts'), 'export {};\n');
        run('add', '.');
        run('commit', '-m', 'init');
      });

      afterEach(() => {
        rmSync(`${project}-worktrees`, { recursive: true, force: true });
      });

      async function startTriage(conveyor: SplitConveyor, projectPath: string): Promise<string> {
        const instance = await withRoutes(conveyor);
        const first = await instance.inject({
          method: 'POST',
          url: '/api/chat/split',
          payload: { projectPath, proposal, startRuns: true, parentChatId: 'parent-1', ...ceiling },
        });
        await instance.close();
        return (first.json() as { triage: { chatId: string } }).triage.chatId;
      }

      function finishTriage(conveyor: SplitConveyor, triageId: string): void {
        const block = [
          '```agentdeck:split-plan',
          JSON.stringify({ groups: [{ index: 1 }, { index: 2 }], order: [1, 2] }),
          '```',
        ].join('\n');
        conveyor.onTriageFinished(
          {
            chatId: triageId,
            projectPath: project,
            text: block,
            ok: true,
            startedAt: 1,
            options: { prompt: '', cwd: project },
            contextTokens: 0,
          },
          [triageId],
        );
      }

      /** Пока конвейер заводит копии (git worktree add), стартов ещё нет. */
      async function waitStarts(count: number): Promise<void> {
        for (let i = 0; i < 100 && started.length < count; i += 1) {
          await new Promise((done) => setTimeout(done, 50));
        }
      }

      // Временный каталог Windows приходит коротким именем (`RUSYAN~1`), git
      // отвечает длинным — сравниваем настоящие пути.
      const norm = (path: string): string =>
        (existsSync(path) ? realpathSync.native(path) : path).replace(/\\/g, '/').toLowerCase();
      const inCopies = (cwd: string): boolean =>
        norm(cwd).startsWith(`${norm(project)}-worktrees/`);

      it('разбор идёт в корне репозитория, группы — каждая в своей копии', async () => {
        const conveyor = withConveyor();
        const triageId = await startTriage(conveyor, sub);
        expect(norm(started[0]?.cwd ?? '')).toBe(norm(project));
        // Запись помнит оба пути (m6): открытый человеком — ключ его настроек,
        // верх репозитория — корень копий.
        const record = store.getSplitPlan('parent-1');
        expect(norm(record?.projectPath ?? '')).toBe(norm(sub));
        expect(norm(record ? copyRootOf(record) : '')).toBe(norm(project));

        started.length = 0;
        finishTriage(conveyor, triageId);
        await waitStarts(2);

        const cwds = started.map((run) => run.cwd);
        expect(cwds).toHaveLength(2);
        expect(new Set(cwds.map(norm)).size).toBe(2);
        expect(cwds.every(inCopies)).toBe(true);
      }, 20_000);

      it('перезапуск из итога разбора уводит группы из подкаталога в копии', async () => {
        const conveyor = withConveyor();
        const triageId = await startTriage(conveyor, project);
        // Запись, какой она была в живом прогоне: разделение из подкаталога.
        const record = store.getSplitPlan('parent-1');
        if (!record) throw new Error('нет записи');
        const { copyRoot: _root, ...legacy } = record;
        store.setSplitPlan({ ...legacy, projectPath: sub });
        started.length = 0;
        finishTriage(conveyor, triageId);
        await waitStarts(2);
        const wrong = started.map((run) => run.chatId);
        expect(started.map((run) => norm(run.cwd))).toEqual([norm(sub), norm(sub)]);

        const instance = await withRoutes(conveyor);
        started.length = 0;
        const response = await instance.inject({
          method: 'POST',
          url: '/api/chat/split/parent-1/relaunch',
        });
        // Перезапуск отвечает сразу (находка 19), копии заводятся фоном.
        expect(response.statusCode).toBe(202);
        await waitStarts(2);
        await instance.close();

        const cwds = started.map((run) => run.cwd);
        expect(cwds).toHaveLength(2);
        expect(new Set(cwds.map(norm)).size).toBe(2);
        expect(cwds.every(inCopies)).toBe(true);
        for (const chatId of wrong) expect(store.getChatLink(chatId)).toBeUndefined();
        const after = store.getSplitPlan('parent-1');
        expect(norm(after?.projectPath ?? '')).toBe(norm(sub));
        expect(norm(after ? copyRootOf(after) : '')).toBe(norm(project));
      }, 20_000);

      /**
       * Находка 20 живого прогона: перезапуск СТИРАЛ связи снятых групп, и восемь
       * старых чатов разом всплыли корнями списка. Теперь звено снимается: для
       * панели оно мертво (ни `getChatLink`, ни `getChatLinks` его не отдают), а
       * список держит разговор под родителем с меткой `retired` — без номера и
       * стадии группы, чтобы хаб не принял его за живую группу.
       */
      it('перезапуск снимает звенья старых групп, а не стирает связи', async () => {
        const conveyor = withConveyor();
        const triageId = await startTriage(conveyor, project);
        started.length = 0;
        finishTriage(conveyor, triageId);
        await waitStarts(2);
        const wrong = started.map((run) => run.chatId);
        expect(wrong).toHaveLength(2);

        // Транскрипты старых групп на диске — список чатов читает их оттуда.
        const dir = join(root, 'projects', 'proj');
        mkdirSync(dir, { recursive: true });
        for (const chatId of wrong) {
          const record = {
            type: 'user',
            uuid: `u-${chatId}`,
            cwd: project,
            timestamp: '2026-09-24T10:00:00.000Z',
            message: { role: 'user', content: `задание ${chatId}` },
          };
          writeFileSync(join(dir, `${chatId}.jsonl`), `${JSON.stringify(record)}\n`);
        }

        const instance = Fastify();
        registerChatSplitRoutes(instance, ctx, { ...launchDeps(), conveyor });
        registerChatTranscriptRoutes(instance, ctx);
        await instance.ready();
        started.length = 0;
        const response = await instance.inject({
          method: 'POST',
          url: '/api/chat/split/parent-1/relaunch',
        });
        expect(response.statusCode).toBe(202);
        await waitStarts(2);
        const list = await instance.inject({ method: 'GET', url: '/api/chats' });
        await instance.close();

        const fresh = started.map((run) => run.chatId);
        expect(fresh).toHaveLength(2);
        expect(fresh.some((chatId) => wrong.includes(chatId))).toBe(false);
        for (const chatId of wrong) {
          expect(store.getChatLink(chatId)).toBeUndefined();
          expect(store.getChatLinks()[chatId]).toBeUndefined();
          expect(store.getRetiredChatLinks()[chatId]).toMatchObject({ parentChatId: 'parent-1' });
          expect(store.getRetiredChatLinks()[chatId]?.retiredAt).toBeTruthy();
        }
        // Новые группы — живые звенья со своими номерами.
        for (const chatId of fresh) {
          expect(store.getChatLink(chatId)?.parentChatId).toBe('parent-1');
          expect(typeof store.getChatLink(chatId)?.groupIndex).toBe('number');
        }

        const chats = list.json() as {
          id: string;
          parentId?: string;
          retired?: boolean;
          groupIndex?: number;
          stage?: string;
          groupTitle?: string;
        }[];
        for (const chatId of wrong) {
          const chat = chats.find((entry) => entry.id === chatId);
          expect(chat).toMatchObject({ parentId: 'parent-1', retired: true });
          expect(chat?.groupIndex).toBeUndefined();
          expect(chat?.stage).toBeUndefined();
          // Имя группы снятое звено держит (WP9h): им оно и называется, когда
          // первая реплика целиком написана панелью.
          expect(chat?.groupTitle).toBe(store.getRetiredChatLinks()[chatId]?.title);
        }
      }, 20_000);
    });
  });
});
