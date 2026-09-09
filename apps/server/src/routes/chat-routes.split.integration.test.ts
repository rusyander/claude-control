import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';
import { createSplitLauncher, launchFromRecord } from './chat/split-launch.ts';
import type { ChatLink } from '../lib/app-store/app-store.types.ts';

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
    for (const chat of body.chats) {
      expect(session.autoApproveFor(chat.chatId)).toEqual({ enabled: true, allowEdits: true });
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
          createSplitLauncher(ctx, launchDeps(), {
            projectPath: record.projectPath,
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
      conveyor.onChainEnded(store.getChatLink(started[0]?.chatId ?? '') as ChatLink, true);
      await new Promise((done) => setTimeout(done, 30));
      expect(started).toHaveLength(2);
      expect(store.getChatLink(started[1]?.chatId ?? '')?.notes).toContain(
        'Раньше этой группы работали: «Раз»',
      );
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
  });
});
