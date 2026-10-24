import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelInfo } from '@agentdeck/contracts';
import { ESCALATE_LINE } from '@agentdeck/contracts/model-cascade';
import { SPLIT_DEFAULTS_BUILTIN } from '@agentdeck/contracts/split-groups';
import {
  FOREIGN_CHILD_PROMPT,
  FOREIGN_GROUP_ECONOMY_PROMPT,
} from '../../domains/chat/initiative/initiative.ts';
import { WORK_HABITS_SHARED_NOTE } from '../../domains/chat/group-profile/group-profile.ts';
import { writePanelJson } from '../../lib/app-store/group-sources.ts';
import { foreignChildExtra } from '../../domains/chat/group-run-lines/group-run-lines.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerChatSplitRoutes } from '../chat/split-routes.ts';
import { startForeignReviewStage } from '../chat/review-starter.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import {
  ProviderChatService,
  listChats,
  readChat,
  readChatCascade,
  type ProviderChatRunOptions,
} from '../../domains/provider-chat/provider-chat.ts';

/**
 * Разделение задач, когда активен ЧУЖОЙ провайдер (Т12).
 *
 * Отдельный файл от разделения у Claude, потому что здесь другой весь путь:
 * разговор заводит хранилище провайдера, прогон идёт одноразовым запуском CLI, а
 * модель подбирается по лестнице провайдера, а не от потолка разговора.
 *
 * Настоящий CLI при этом не запускается: подменяется фабрика прогона службы —
 * ровно та же точка, в которой её подменяют собственные тесты службы. Проверяется
 * то, что уедет в argv (модель и глубина), название разговора и память шапки.
 */
describe('POST /api/chat/split — чужой провайдер', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let appData: string;
  let providerChats: ProviderChatService;
  let runs: ProviderChatRunOptions[];
  let deferred: string[];
  let paused = false;
  let ctx: ServerContext;

  const catalog = [
    { id: 'gpt-5.3-codex-spark', name: 'spark', family: 'gpt-codex-spark', releaseDate: '2026-02' },
    { id: 'gpt-5.3-codex', name: 'codex', family: 'gpt-codex', releaseDate: '2026-02' },
  ] as unknown as ModelInfo[];

  const proposal = {
    groups: [
      { title: 'Переименования', branch: 'split/rename', tasks: ['раз'], kind: 'mechanical' },
      { title: 'Архитектура', branch: 'split/design', tasks: ['два'], kind: 'design' },
    ],
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-foreign-'));
    project = mkdtempSync(join(tmpdir(), 'cc-split-foreign-proj-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });

    runs = [];
    providerChats = new ProviderChatService(() => ({
      start: async (options, onEvent) => {
        runs.push(options);
        onEvent({ type: 'done', reply: 'готово', transport: 'stream' });
      },
      stop: () => undefined,
    }));

    store = new AppStore(appData);
    store.updateSettings({ provider: 'codex' });

    ctx = {
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
    deferred = [];
    registerChatSplitRoutes(app, ctx, {
      runs: registry,
      providerChats,
      session: new ChatSession(registry),
      // Ворота паузы дерева (Т5): по умолчанию открыты, тест их закрывает.
      gate: {
        defer: (kind, chatId) => {
          if (!paused) return false;
          deferred.push(`${kind}:${chatId}`);
          return true;
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const split = async (): Promise<{
    chats: { title: string; started: boolean; model?: string; kind?: string }[];
  }> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true, parentChatId: 'родитель' },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  it('механика едет младшей ступенью лестницы, а класс-потолок — без модели', async () => {
    const body = await split();

    expect(body.chats.map((chat) => chat.model)).toEqual(['gpt-5.3-codex-spark', undefined]);
    expect(runs).toHaveLength(2);
    // Ровно то, что уедет в argv: модель у понижённой группы и НИЧЕГО у той,
    // которой положен потолок, — потолок у чужого CLI это его настройка.
    expect(runs[0]?.model).toBe('gpt-5.3-codex-spark');
    expect(runs[0]?.effort).toBe('medium');
    expect(runs[1]?.model).toBe(undefined);
    expect(runs[1]?.effort).toBe(undefined);
  });

  it('понижённой группе дописывается планка сдачи, группе на потолке — нет', async () => {
    await split();

    expect(runs[0]?.systemPrefix).toContain('BELOW the one the CLI uses by its own setting');
    // Ревью здесь обещается, но не «моделью-потолком»: потолка у чужого CLI нет,
    // и проверку панель заводит прогоном без подобранной ступени.
    expect(runs[0]?.systemPrefix).toContain('on the model the CLI itself is configured with');
    expect(runs[0]?.systemPrefix ?? '').not.toContain('the ceiling of the conversation');
    expect(runs[1]?.systemPrefix ?? '').not.toContain('BELOW');
  });

  /**
   * Стадия — единственное, чем конвейер у чужого CLI вообще держится: не запиши
   * её разделение, ревью не завелось бы никогда. Группа на потолке получает
   * шапку тоже (F3, 12.10.2026): без неё конвейер обрывался до ревью и до конца
   * цепочки, и группы, ждущие её через `after`, ждали вечно.
   */
  it('шапка работы — у каждой группы: понижённой с назначением, на потолке без модели (F3)', async () => {
    await split();

    const lowered = listChats(appData, 'codex').find((item) => item.title === 'Переименования');
    expect(readChatCascade(appData, 'codex', lowered?.id ?? '')).toMatchObject({
      stage: 'work',
      lowered: true,
      kind: 'mechanical',
      group: 'Переименования',
      workModel: 'gpt-5.3-codex-spark',
      workEffort: 'medium',
    });
    // Ветка копии нужна ревьюеру: дифф он читает именно в ней.
    expect(readChatCascade(appData, 'codex', lowered?.id ?? '')?.branch).toBeTruthy();

    const ceiling = listChats(appData, 'codex').find((item) => item.title === 'Архитектура');
    const head = readChatCascade(appData, 'codex', ceiling?.id ?? '');
    expect(head).toMatchObject({ stage: 'work', group: 'Архитектура' });
    expect(head?.branch).toBeTruthy();
    // Потолок чужого CLI — его собственная настройка: ни модели, ни «ниже».
    expect(head?.workModel).toBeUndefined();
    expect(head?.lowered).toBeUndefined();
  });

  // Раунд 5: чужие дети получали без чисел группы и без строки эскалации то,
  // что ребёнок Claude получает в дописке (`childStageExtra`).
  it('ребёнок получает числа группы родителя и строку эскалации — как у Claude', async () => {
    store.saveGroup({
      id: 'x',
      name: 'Набор X',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'ladder' }],
      env: {},
      projectPaths: [],
      knobs: { 'ladder:review-rounds': 4 },
      isEnabled: true,
      order: 0,
    });
    writePanelJson(appData, 'skill-knobs.json', {
      'global|skill:ladder': {
        hash: 'h',
        knobs: [
          {
            key: 'review-rounds',
            skillId: 'ladder',
            label: { ru: 'Круги ревью', en: 'Review rounds' },
            default: 2,
            min: 1,
            max: 5,
            quote: 'Run 2 review rounds.',
          },
        ],
      },
    });
    store.setChatGroupSettings('codex:родитель', { groupChoice: 'global:x' });

    await split();

    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.systemPrefix).toContain(ESCALATE_LINE);
      expect(run.systemPrefix).toContain('ladder — Review rounds: 4 (skill default 2)');
      // Та же строка, что соберут ответ человека, переход стадии и продолжение.
      expect(run.systemPrefix).toContain(foreignChildExtra(store, appData, `codex:${run.chatId}`));
    }

    // E6: продолжение разговора панелью (пауза, лимит, слово родителя) идёт с
    // той же шапкой, что и старт, — до правки с голыми инициативами.
    const first = runs[0]!;
    const key = `codex:${first.chatId}`;
    const resumed = startForeignReviewStage(
      ctx,
      { providerChats } as unknown as Parameters<typeof startForeignReviewStage>[1],
      'codex',
      {
        chatId: key,
        prompt: 'The human paused the group and is now resuming it.',
        cwd: project,
        stage: 'tell',
        fromAliases: [key],
        resume: { sessionId: key },
      },
    );
    expect(resumed.started).toBe(true);
    expect(runs).toHaveLength(3);
    expect(runs[2]?.systemPrefix).toBe(first.systemPrefix);
  });

  /**
   * Ребёнок Claude получает правила группы системной дописью (`CHILD_PROMPT`,
   * фон только для служебного); ребёнок чужого CLI не получал их вовсе (TQ-06,
   * 12.10.2026) — а в задании ему велели спрашивать инструментом, которого у
   * него нет (F8).
   */
  it('ребёнок чужого CLI получает правила группы — без инструмента вопросов (TQ-06, F8)', async () => {
    store.setSplitDefaults({ ...structuredClone(SPLIT_DEFAULTS_BUILTIN), groupQuestions: 'human' });

    await split();

    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.systemPrefix).toContain(FOREIGN_CHILD_PROMPT);
      // Правило расхода (этап 2–4 плана экономии) — и чужому CLI, своим вариантом
      // строки: без имени инструмента `Edit`, которого у него нет.
      expect(run.systemPrefix).toContain(FOREIGN_GROUP_ECONOMY_PROMPT);
      // Привычки (рычаг `workHabits`, включён по умолчанию) — общая часть строки Claude.
      expect(run.systemPrefix).toContain(WORK_HABITS_SHARED_NOTE);
      expect(run.systemPrefix).not.toContain('do not `cd`');
      const said = [run.systemPrefix ?? '', ...run.history.map((message) => message.content)];
      expect(said.join('\n')).not.toContain('AskUserQuestion');
      expect(said.join('\n')).toContain('last line of your answer');
    }
  });

  it('разговор называется группой, а не служебным ключом', async () => {
    await split();

    const titles = listChats(appData, 'codex').map((chat) => chat.title);
    expect(titles).toEqual(expect.arrayContaining(['Переименования', 'Архитектура']));
    expect(titles.some((title) => title.startsWith('new-'))).toBe(false);
  });

  it('назначение помнится шапкой разговора и действует на следующее сообщение', async () => {
    await split();

    const chat = listChats(appData, 'codex').find((item) => item.title === 'Переименования');
    expect(chat?.model).toBe('gpt-5.3-codex-spark');

    // Второе сообщение приходит БЕЗ назначения (телефон и API его не шлют) —
    // модель обязана взяться из шапки, иначе работа продолжилась бы не тем, чем
    // началась.
    providerChats.send(appData, 'codex', chat?.id ?? '', { text: 'дальше' }, {
      provider: { id: 'codex' },
    } as unknown as Parameters<ProviderChatService['send']>[4]);

    expect(runs.at(-1)?.model).toBe('gpt-5.3-codex-spark');
    expect(runs.at(-1)?.effort).toBe('medium');
  });

  /**
   * Связь чужого чата (Т2). До этой партии её не было вовсе, и без неё слепло
   * всё разом: хаб родителя, стадии, сверка веток, пауза дерева. Ключ
   * именованный — идентификатор чужому разговору выдаёт его хранилище, и в одном
   * пространстве с сессиями Claude он обязан быть однозначным.
   */
  it('связь пишется на каждую группу — именованным ключом и с теми же полями', async () => {
    await split();

    const chats = listChats(appData, 'codex');
    expect(chats).toHaveLength(2);
    for (const chat of chats) {
      // «Голым» идентификатором связь чужого чата не находится: под ним живут
      // разговоры Claude.
      expect(store.getChatLink(chat.id)).toBe(undefined);
      const link = store.getChatLink(`codex:${chat.id}`);
      expect(link).toMatchObject({ parentChatId: 'codex:родитель', title: chat.title });
      expect(link?.branch).toBeTruthy();
      expect(link?.createdAt).toBeTruthy();
    }

    // Понижённая группа несёт в связи то же, что и у Claude: назначение и класс.
    const lowered = chats.find((item) => item.title === 'Переименования');
    expect(store.getChatLink(`codex:${lowered?.id}`)).toMatchObject({
      stage: 'work',
      model: 'gpt-5.3-codex-spark',
      effort: 'medium',
      kind: 'mechanical',
      lowered: true,
    });

    // Родитель — не потомок: своей связи у него нет ни под каким ключом.
    expect(store.getChatLink('родитель')).toBe(undefined);
    expect(store.getChatLink('codex:родитель')).toBe(undefined);
  });

  it('родителя не назвали — связей нет, и разделение работает как раньше', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });
    expect(response.statusCode).toBe(200);

    for (const chat of listChats(appData, 'codex')) {
      expect(store.getChatLink(`codex:${chat.id}`)).toBe(undefined);
    }
  });

  /**
   * Пауза дерева (Т5). Копия и связь заводятся как обычно — иначе после
   * «Продолжить всё» запускать было бы нечего, — а прогон не идёт.
   */
  it('дерево на паузе — группы заведены и связаны, но ни один CLI не запущен', async () => {
    paused = true;
    try {
      const body = await split();

      expect(body.chats.every((chat) => !chat.started)).toBe(true);
      expect(runs).toHaveLength(0);
      // Отложены именованные ключи — по ним продолжение и запустит группы.
      expect(deferred).toHaveLength(2);
      expect(deferred.every((key) => key.startsWith('split:codex:'))).toBe(true);
      const links = Object.keys(store.getChatLinks()).filter((key) => key.startsWith('codex:'));
      expect(links).toHaveLength(2);
    } finally {
      paused = false;
    }
  });

  it('выключенный в проекте подбор отменяет и подбор у чужого провайдера', async () => {
    store.setProjectCascade(project, false);

    const body = await split();

    expect(body.chats.every((chat) => chat.model === undefined)).toBe(true);
    expect(runs.every((run) => run.model === undefined)).toBe(true);
    // Первый вопрос всё равно записан в переписку — выключен подбор, а не чат.
    expect(
      readChat(appData, 'codex', listChats(appData, 'codex')[0]?.id ?? '')?.messages,
    ).toHaveLength(2);
  });
});
