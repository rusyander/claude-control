import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AUTONOMOUS_PICK_MARKER } from '@agentdeck/contracts/chat-group-settings';
import { GROUP_PLAN_FREE_ANSWER } from '@agentdeck/contracts/task-split';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
  type RunNotice,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { translate } from '../../../domains/chat/ChatRunner/ChatRunner.ts';
import type { ChatEvent } from '../../../domains/chat/chat-events.ts';
import { QUESTION_DENIED } from '../../../domains/chat/initiative/initiative.ts';
import {
  hasParentLink,
  wirePendingAsks,
  type PendingAsks,
} from '../../../domains/chat/pending-asks/pending-asks.ts';
import { wireChatAutonomy } from '../../../bootstrap/chat-autonomy-wiring.ts';
import {
  forgetGroupQuestions,
  GROUP_REASK_LINE,
  GROUP_REASK_MAX,
} from '../../../domains/chat/group-permissions.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Вопрос группы под «Развилки группы: по плану» — через НАСТОЯЩИЙ маршрут, который
 * зовёт сервер прав CLI (`/api/chat/permission-request`), настоящий реестр,
 * сборку автономии из `runtime.ts` (`wireChatAutonomy`) и запись вопросов для
 * хаба. Заглушен только процесс CLI: события он отдаёт теми же кадрами, что
 * разбор его потока (`translate`), включая результат вызова с ответом брокера.
 *
 * Живой случай 23.10: ревью-звено группы спросило «сессия стенда b-inst
 * устарела, живая проверка не пройдёт — что делать?» с вариантами «вошёл через
 * qa:login, продолжай» (описание утверждает, что человек уже запустил
 * `npm run qa:login`) и «сдать без живой проверки (рекомендую)» — и стояло, пока
 * владелец не нажал.
 */
describe('маршрут прав: вопрос группы «по плану» отвечается сразу', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let asks: PendingAsks;
  let notices: RunNotice[];
  let feed: ChatEvent[];
  let emits: Map<string, (event: ChatEvent) => void>;
  const detaches: (() => void)[] = [];
  const GROUP = 'group-chat';
  const PLAIN = 'plain-chat';

  const LIVE = {
    questions: [
      {
        question:
          'Сессия стенда b-inst устарела, живая проверка не пройдёт. Что делать с доставкой?',
        header: 'Доставка',
        multiSelect: false,
        options: [
          {
            label: 'Вошёл через qa:login, продолжай',
            description: 'Я уже запустил npm run qa:login -- --profile b-inst и вошёл на стенд.',
          },
          {
            label: 'Сдать без живой проверки (рекомендую)',
            description: 'MR без живой проверки, пробел — в описании.',
          },
        ],
      },
    ],
  };

  let calls = 0;
  /**
   * Полный круг вызова: CLI пишет `tool_use` в поток, сервер прав зовёт маршрут,
   * ответ брокера возвращается в поток результатом вызова. Ответ — что вернул маршрут.
   */
  const askThroughCli = async (chatId: string, input: unknown) => {
    calls += 1;
    const toolUseId = `toolu_${calls}`;
    const emit = emits.get(chatId)!;
    for (const event of translate({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input }] },
    } as Parameters<typeof translate>[0])) {
      emit(event);
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: chatId, toolName: 'AskUserQuestion', input, toolUseId },
    });
    const body = response.json<{ behavior: string; message: string }>();
    for (const event of translate({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: body.message }],
      },
    } as Parameters<typeof translate>[0])) {
      emit(event);
    }
    return { status: response.statusCode, toolUseId, ...body };
  };

  beforeEach(async () => {
    forgetGroupQuestions();
    root = mkdtempSync(join(tmpdir(), 'cc-group-questions-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'parent',
      projectPath: root,
      createdAt: new Date().toISOString(),
      order: [0],
      request: { allowEdits: true },
      proposal: { groups: [] },
      groups: [{ index: 0, branch: 'feature/a', status: 'running', chatId: GROUP }],
    } as unknown as SplitPlanRecord);
    store.setChatLink(GROUP, {
      parentChatId: 'parent',
      groupIndex: 0,
      branch: 'feature/a',
      createdAt: new Date().toISOString(),
    });
    feed = [];
    notices = [];
    emits = new Map();
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) =>
        new Promise<void>(() => {
          emits.set(options.permissionPrompt?.runId ?? '', onEvent);
        }),
      stop: () => undefined,
    }));
    registry.setNotifier((notice) => notices.push(notice));
    wireChatAutonomy({
      store,
      chatRuns: registry,
      say: (chatId, event) => registry.emitExternal(chatId, event),
      broadcast: () => undefined,
    });
    asks = wirePendingAsks(registry, {
      isTreeChat: hasParentLink((key) => store.getChatLink(key)),
    });
    const ctx = {
      store,
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
    registerChatRunRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
    // Прогону без брокера нечего звать: прогон с ключом брокера — как у живой группы.
    for (const chatId of [GROUP, PLAIN]) {
      registry.start(
        chatId,
        {
          prompt: 'задача',
          cwd: root,
          permissionPrompt: { runId: chatId, baseUrl: 'http://127.0.0.1:1' },
        },
        { projectPath: root },
      );
      detaches.push(
        registry.attach(chatId, 0, {
          send: ({ event }) => void feed.push(event),
          close: () => undefined,
        }) as () => void,
      );
    }
  });

  afterEach(async () => {
    for (const detach of detaches.splice(0)) detach();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const questionPushes = (chatId: string): number =>
    notices.filter((notice) => notice.kind === 'question' && notice.chatId === chatId).length;

  it('живой случай: рекомендованный вариант, не ложный «вошёл»; человека не зовут', async () => {
    const answer = await askThroughCli(GROUP, LIVE);
    expect(answer.status).toBe(200);
    expect(answer.behavior).toBe('deny');
    expect(answer.message).toContain(AUTONOMOUS_PICK_MARKER);
    expect(answer.message).toContain('→ "Сдать без живой проверки (рекомендую)"');
    expect(answer.message).not.toContain('→ "Вошёл через qa:login, продолжай"');
    // Лента: строка автовыбора с тем же вариантом, карточки прав нет.
    const picked = feed.filter(
      (event): event is Extract<ChatEvent, { kind: 'autoPick' }> => event.kind === 'autoPick',
    );
    expect(picked.map((event) => event.picks.map((pick) => pick.label))).toEqual([
      ['Сдать без живой проверки (рекомендую)'],
    ]);
    expect(feed.some((event) => event.kind === 'permission')).toBe(false);
    // Ни пуша «вопрос», ни записи «ждёт вас» для хаба и сводки.
    expect(questionPushes(GROUP)).toBe(0);
    expect(asks.of([GROUP], () => true)).toEqual([]);
    // Хаб родителя: отметка «ответ дан автоматически».
    expect(store.getSplitPlan('parent')?.groups[0]?.autoNotices).toEqual([
      expect.objectContaining({ kind: 'answer', summary: 'Сдать без живой проверки (рекомендую)' }),
    ]);
  });

  it('тот же вопрос снова — снова ответ сразу, без отката к человеку', async () => {
    await askThroughCli(GROUP, LIVE);
    const again = await askThroughCli(GROUP, LIVE);
    expect(again.message).toContain('→ "Сдать без живой проверки (рекомендую)"');
    expect(questionPushes(GROUP)).toBe(0);
    expect(asks.of([GROUP], () => true)).toEqual([]);
    expect(store.getSplitPlan('parent')?.groups[0]?.autoNotices).toHaveLength(2);
  });

  // F-128: петля «спросил — получил ответ — спросил снова» без конца.
  it('тот же вопрос сверх потолка — тот же ответ и порядок больше не спрашивать, человека не зовут', async () => {
    for (let i = 0; i < GROUP_REASK_MAX; i += 1) {
      const answer = await askThroughCli(GROUP, LIVE);
      expect(answer.message).toContain(AUTONOMOUS_PICK_MARKER);
      expect(answer.message).not.toContain(GROUP_REASK_LINE);
    }
    const looped = await askThroughCli(GROUP, LIVE);
    expect(looped.behavior).toBe('deny');
    expect(looped.message).toContain('→ "Сдать без живой проверки (рекомендую)"');
    expect(looped.message).toContain(GROUP_REASK_LINE);
    expect(questionPushes(GROUP)).toBe(0);
    expect(asks.of([GROUP], () => true)).toEqual([]);
    // Отметок в хабе — по числу данных ответов, отказ их не плодит.
    expect(store.getSplitPlan('parent')?.groups[0]?.autoNotices).toHaveLength(GROUP_REASK_MAX);
    // Другой вопрос той же группы считается отдельно.
    const other = await askThroughCli(GROUP, {
      questions: [{ ...LIVE.questions[0], question: 'Другой вопрос: что с описанием MR?' }],
    });
    expect(other.message).toContain(AUTONOMOUS_PICK_MARKER);
  });

  it('несколько вопросов в одном вызове — ответ на каждый; не подошёл ни один — свободный текст', async () => {
    const answer = await askThroughCli(GROUP, {
      questions: [
        LIVE.questions[0],
        {
          question: 'Когда продолжать?',
          options: [{ label: 'Когда я обновлю сессию' }, { label: 'Подожди меня' }],
        },
      ],
    });
    expect(answer.message).toContain('→ "Сдать без живой проверки (рекомендую)"');
    expect(answer.message).toContain(`→ ${JSON.stringify(GROUP_PLAN_FREE_ANSWER)}`);
    expect(questionPushes(GROUP)).toBe(0);
    const notices = store.getSplitPlan('parent')?.groups[0]?.autoNotices ?? [];
    expect(notices.map((notice) => notice.free === true)).toEqual([false, true]);
  });

  it('«спрашивать меня» — как раньше: вопрос уходит человеку', async () => {
    store.setSplitDefaults({ groupQuestions: 'human' });
    const answer = await askThroughCli(GROUP, LIVE);
    expect(answer.message).toBe(QUESTION_DENIED);
    expect(questionPushes(GROUP)).toBe(1);
    expect(asks.of([GROUP], () => true)).toHaveLength(1);
    expect(store.getSplitPlan('parent')?.groups[0]?.autoNotices).toBeUndefined();
  });

  it('обычный чат не группа: вопрос без рекомендации — человеку, как было', async () => {
    const answer = await askThroughCli(PLAIN, {
      questions: [{ question: 'Что?', options: [{ label: 'А' }, { label: 'Б' }] }],
    });
    expect(answer.message).toBe(QUESTION_DENIED);
    expect(questionPushes(PLAIN)).toBe(1);
  });

  it('автономия, выключенная человеком в самом чате группы, — вопрос ему', async () => {
    store.setChatGroupSettings(GROUP, { autonomous: false });
    const answer = await askThroughCli(GROUP, LIVE);
    expect(answer.message).toBe(QUESTION_DENIED);
    expect(questionPushes(GROUP)).toBe(1);
  });
});
