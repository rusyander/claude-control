import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelInfo } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { createSplitLauncher, launchFromRecord } from './chat/split-launch.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import {
  ProviderChatService,
  createForeignStagePlanner,
  listChats,
  readChat,
  readChatCascade,
  type ProviderChatRunOptions,
} from '../domains/provider-chat.ts';
import { getProvider } from '../providers/registry.ts';

/**
 * Уровни разделения у ЧУЖОГО CLI (Т3 партии «автономия у чужих CLI»): разбор в
 * корне, потом план в копии, потом работа.
 *
 * Отдельный файл от `chat-routes.split.foreign.integration.test.ts`, потому что
 * здесь собран весь конвейер целиком — маршрут, `SplitConveyor` и планировщик
 * звеньев на завершении ответа. Настоящий CLI не запускается: подменяется
 * фабрика прогона службы, а ответ она даёт по последнему вопросу — так один
 * стенд отыгрывает и разбор, и план, и работу, и ревью.
 *
 * Главное, что здесь доказывается: у чужого CLI потолок — это прогон БЕЗ флага
 * модели, и потому уровни ему доступны ровно так же, как Claude.
 */
describe('POST /api/chat/split — уровни у чужого провайдера', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let appData: string;
  let providerChats: ProviderChatService;
  let runs: ProviderChatRunOptions[];
  /**
   * Что отвечает подставной CLI на очередной вопрос — ставится тестом. `null` —
   * прогон не заканчивается вовсе: так проверяется состояние ДО ответа.
   */
  let reply: (prompt: string) => string | null;

  const catalog = [
    { id: 'gpt-5.3-codex-spark', name: 'spark', family: 'gpt-codex-spark', releaseDate: '2026-02' },
    { id: 'gpt-5.3-codex', name: 'codex', family: 'gpt-codex', releaseDate: '2026-02' },
  ] as unknown as ModelInfo[];

  /** Три группы механики: подбор понижает все три, и у каждой будет план. */
  const proposal = {
    groups: [
      { title: 'Чтение', branch: 'split/read', tasks: ['разобрать парсер'], kind: 'mechanical' },
      { title: 'Запись', branch: 'split/write', tasks: ['починить буфер'], kind: 'mechanical' },
      { title: 'Отчёт', branch: 'split/report', tasks: ['свести колонки'], kind: 'mechanical' },
    ],
  };

  const TRIAGE_MARK = 'Это разбор разделения задач';
  const PLAN_MARK = 'План работы для группы';

  /** Блок разбора: вторая группа ждёт первую, третья стоит с вопросом. */
  const triagePlan = JSON.stringify({
    groups: [
      { index: 1, owns: ['src/read.ts'], tasks: ['разобрать парсер'], after: [] },
      {
        index: 2,
        owns: ['src/write.ts'],
        tasks: ['починить буфер'],
        after: [1],
        notes: 'ждёт чтения',
      },
      {
        index: 3,
        owns: ['src/report.ts'],
        tasks: ['свести колонки'],
        after: [],
        hold: 'Колонки в CSV или в JSON?',
      },
    ],
    order: [1, 2, 3],
  });
  const triageAnswer = `Развёл группы.\n\n\`\`\`agentdeck:split-plan\n${triagePlan}\n\`\`\`\n`;
  const planAnswer =
    'Готов план.\n\n```agentdeck:plan\n1. Прочитать src/read.ts\n2. Починить разбор строк\n```\n';

  const sleep = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-levels-'));
    project = mkdtempSync(join(tmpdir(), 'cc-split-levels-proj-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });

    runs = [];
    reply = () => 'готово';
    providerChats = new ProviderChatService(() => ({
      start: async (options, onEvent) => {
        runs.push(options);
        const prompt = options.history.at(-1)?.content ?? '';
        const answer = reply(prompt);
        if (answer !== null) onEvent({ type: 'done', reply: answer, transport: 'stream' });
      },
      stop: () => undefined,
    }));

    store = new AppStore(appData);
    store.updateSettings({ provider: 'codex' });

    const ctx = {
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(appData, 'backups'),
      models: { current: () => ({ models: catalog }) },
    } as unknown as ServerContext;

    app = Fastify();
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async () => undefined,
      stop: () => undefined,
    }));
    const deps = {
      runs: registry,
      providerChats,
      session: new ChatSession(registry),
      log: { warn: () => undefined },
    };

    const conveyor = new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (ids) => store.findSplitPlanByTriage(ids),
        all: () => store.getSplitPlans(),
      },
      launch: (record, groups, context) => launchFromRecord(ctx, deps, record, groups, context),
      startTriage: (record, prompt, claim) =>
        createSplitLauncher(ctx, deps, {
          projectPath: record.projectPath,
          parentChatId: record.parentChatId,
        }).startTriage(prompt, claim),
      log: () => undefined,
    });

    providerChats.setFinishedListener(
      createForeignStagePlanner({
        chats: providerChats,
        provider: (id) => (id === 'codex' ? getProvider('codex') : undefined),
        models: () => catalog,
        settings: () => store.getSettings(),
        // Дифф в копии тут ни при чём: git в тесте нет, проверяются уровни.
        hasWork: () => true,
        linkOf: (key) => store.getChatLink(key),
        saveLink: (key, link) => store.setChatLink(key, link),
        onTriage: ({ chatKey, ok, text }) => {
          const event = conveyor.onTriageFinished({ ok, text }, [chatKey]);
          return event?.kind === 'notice' ? event.text : undefined;
        },
        onChainEnded: (link, ok) => conveyor.onChainEnded(link, ok),
      }),
    );

    registerChatSplitRoutes(app, ctx, { ...deps, conveyor });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const split = async (): Promise<{
    chats: { title: string; started: boolean }[];
    triage?: { chatId: string; path: string; started: boolean };
  }> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true, parentChatId: 'qa1' },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  const chatByTitle = (title: string) => listChats(appData, 'codex').find((c) => c.title === title);

  it('разбор идёт одним прогоном в корне репозитория и без флага модели', async () => {
    // Разбор молчит: так в прогонах остаётся ровно он один.
    reply = () => null;
    const body = await split();

    // Копий ещё нет: они заводятся по итогу разбора.
    expect(body.chats).toEqual([]);
    expect(body.triage?.started).toBe(true);
    expect(body.triage?.path).toBe(project);

    const triage = chatByTitle('Разбор разделения');
    expect(triage?.workdir).toBe(project);
    // Потолок чужого CLI — это отсутствие флага модели, а не его настройка.
    expect(triage?.model).toBe(undefined);
    expect(readChatCascade(appData, 'codex', triage?.id ?? '')?.stage).toBe('triage');

    // Ровно один прогон, и в нём задание разбора.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.model).toBe(undefined);
    expect(runs[0]?.history.at(-1)?.content).toContain(TRIAGE_MARK);
    expect(runs[0]?.history.at(-1)?.content).toContain('НИЧЕГО НЕ ПРАВЬ');

    // Связь разбора — именованным ключом и под именованным родителем.
    const link = store.getChatLink(`codex:${triage?.id}`);
    expect(link).toMatchObject({ parentChatId: 'codex:qa1', stage: 'triage' });
  });

  it('блок разбора применяется: owns и notes в связи, after ждёт, hold стоит без чата', async () => {
    reply = (prompt) => (prompt.includes(TRIAGE_MARK) ? triageAnswer : null);
    await split();
    await sleep();

    const record = store.getSplitPlan('codex:qa1');
    expect(record?.groups.map((group) => group.status)).toEqual(['started', 'waiting', 'held']);
    expect(record?.groups[2]?.hold).toBe('Колонки в CSV или в JSON?');

    // Стартовала ровно первая группа, и стартовала ПЛАНОМ.
    expect(chatByTitle('Запись')).toBe(undefined);
    expect(chatByTitle('Отчёт')).toBe(undefined);
    const plan = chatByTitle('Чтение');
    expect(plan?.model).toBe(undefined);
    expect(readChatCascade(appData, 'codex', plan?.id ?? '')).toMatchObject({
      stage: 'plan',
      group: 'Чтение',
      lowered: true,
      workModel: 'gpt-5.3-codex-spark',
    });
    expect(runs.at(-1)?.history.at(-1)?.content).toContain(PLAN_MARK);
    // План идёт на потолке: планка сдачи его не касается — она про работу.
    expect(runs.at(-1)?.systemPrefix ?? '').not.toContain('НИЖЕ той, которой CLI работает');

    // Границы и заметки разбора уехали в связь: по ним соберётся работа.
    const link = store.getChatLink(`codex:${plan?.id}`);
    expect(link).toMatchObject({ stage: 'plan', workModel: 'gpt-5.3-codex-spark' });
    expect(link?.owns).toEqual(['src/read.ts']);
    expect(link?.task).toContain('разобрать парсер');
  });

  it('работа стартует после плана, несёт его целиком и идёт подобранной ступенью', async () => {
    reply = (prompt) =>
      prompt.includes(TRIAGE_MARK)
        ? triageAnswer
        : prompt.includes(PLAN_MARK)
          ? planAnswer
          : 'сделал';
    await split();
    await sleep();

    const work = chatByTitle('Чтение · работа');
    expect(work?.model).toBe('gpt-5.3-codex-spark');
    expect(readChatCascade(appData, 'codex', work?.id ?? '')).toMatchObject({
      stage: 'work',
      lowered: true,
      workModel: 'gpt-5.3-codex-spark',
    });
    const first = readChat(appData, 'codex', work?.id ?? '')?.messages[0]?.content ?? '';
    expect(first).toContain('Починить разбор строк');
    expect(first).toContain('разобрать парсер');
    // По плану работа заводится ровно один раз.
    const plan = chatByTitle('Чтение');
    expect(readChatCascade(appData, 'codex', plan?.id ?? '')?.plannedAt).toBeTruthy();
  });

  it('плана не получено — работа всё равно идёт, а лента говорит об этом', async () => {
    reply = (prompt) =>
      prompt.includes(TRIAGE_MARK) ? triageAnswer : 'посмотрел, но блока не дам';
    await split();
    await sleep();

    expect(chatByTitle('Чтение · работа')).toBeTruthy();
    const plan = chatByTitle('Чтение');
    const notices = (readChat(appData, 'codex', plan?.id ?? '')?.messages ?? []).filter(
      (message) => message.role === 'notice',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.content).toContain('План не получен');
  });

  it('разбора не получено — группы идут как предложено, а в ленте разбора сказано почему', async () => {
    reply = (prompt) => (prompt.includes(TRIAGE_MARK) ? 'ничего не понял' : 'сделал');
    await split();
    await sleep();

    const record = store.getSplitPlan('codex:qa1');
    expect(record?.triage?.received).toBe(false);
    // Ни одна группа не осталась стоять: уровень не блокирует.
    expect(record?.groups.every((group) => group.status !== 'pending')).toBe(true);
    expect(chatByTitle('Чтение')).toBeTruthy();
    expect(chatByTitle('Запись')).toBeTruthy();
    expect(chatByTitle('Отчёт')).toBeTruthy();

    const triage = chatByTitle('Разбор разделения');
    const notice = (readChat(appData, 'codex', triage?.id ?? '')?.messages ?? []).find(
      (message) => message.role === 'notice',
    );
    expect(notice?.content).toContain('Разбор не получен');
  });

  it('конец цепочки группы отпускает того, кто её ждал', async () => {
    reply = (prompt) =>
      prompt.includes(TRIAGE_MARK)
        ? triageAnswer
        : prompt.includes(PLAN_MARK)
          ? planAnswer
          : 'сделал';
    await split();
    await sleep(200);

    // Первая группа прошла план → работу → ревью и закрылась; вторая ждала её и
    // завелась ПОСЛЕ этого — своим планом, как и первая.
    const record = store.getSplitPlan('codex:qa1');
    expect(record?.groups[0]?.status).toBe('done');
    expect(record?.groups[1]?.startedAt).toBeTruthy();
    expect((record?.groups[1]?.startedAt ?? '') >= (record?.groups[0]?.doneAt ?? '')).toBe(true);
    expect(chatByTitle('Запись')).toBeTruthy();
    // Предшественник назван группе заметкой: без него она не знает, где искать
    // правки, которых ждала.
    expect(store.getChatLink(`codex:${chatByTitle('Запись')?.id}`)?.notes).toContain('Чтение');
  });

  it('ответ на вопрос разбора заводит стоявшую группу', async () => {
    reply = (prompt) => (prompt.includes(TRIAGE_MARK) ? triageAnswer : null);
    await split();
    await sleep();

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split/codex%3Aqa1/hold',
      payload: { index: 2, answer: 'Колонки в CSV' },
    });
    expect(response.statusCode).toBe(200);
    await sleep();

    expect(chatByTitle('Отчёт')).toBeTruthy();
    // Ответ человека уехал группе заметкой — иначе спрашивать было незачем.
    expect(store.getChatLink(`codex:${chatByTitle('Отчёт')?.id}`)?.notes).toContain(
      'Колонки в CSV',
    );
  });

  it('подбор выключен на проекте — уровней нет, группы стартуют как раньше', async () => {
    store.setProjectCascade(project, false);
    reply = () => 'сделал';
    const body = await split();

    expect(body.triage).toBe(undefined);
    expect(body.chats).toHaveLength(3);
    expect(chatByTitle('Разбор разделения')).toBe(undefined);
    // Ни планов, ни назначений: разделение ведёт себя как до партии подбора.
    expect(readChatCascade(appData, 'codex', chatByTitle('Чтение')?.id ?? '')).toBe(undefined);
    expect(runs.every((run) => run.model === undefined)).toBe(true);
  });
});
