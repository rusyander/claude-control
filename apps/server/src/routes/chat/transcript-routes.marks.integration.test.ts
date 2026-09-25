import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatSummary } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../context.ts';
import { PendingAsks } from '../../domains/chat/pending-asks.ts';
import { registerChatTranscriptRoutes } from './transcript-routes.ts';
import { retiredGroupsOf } from '../../domains/chat/split-conveyor.ts';

/**
 * Метки «ждёт вас» и «принято» в списке чатов (итоговое ревью 25.09): раньше
 * они были только в сводке хаба, и в списке ждущий ребёнок и принятая группа
 * выглядели просто молчащими чатами. Маршрут настоящий, транскрипты — файлы на
 * диске, вопрос заводит настоящее хранилище вопросов по тексту хода.
 */
describe('GET /api/chats — метки «ждёт вас» и «принято»', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let asks: PendingAsks;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-chat-marks-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    asks = new PendingAsks({ isTreeChat: () => true });
    const ctx = {
      store,
      location: { paths: { root, appData: join(root, 'agentdeck') } },
      pricing: { current: () => ({ entries: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatTranscriptRoutes(
      app,
      ctx,
      undefined,
      (chatId) => asks.of([chatId], () => false).length > 0,
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  function child(chatId: string, groupIndex: number): void {
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const record = {
      type: 'user',
      uuid: `u-${chatId}`,
      sessionId: chatId,
      cwd: join(root, 'work'),
      timestamp: '2026-09-25T10:00:00.000Z',
      message: { role: 'user', content: 'Поправь вход' },
    };
    writeFileSync(join(dir, `${chatId}.jsonl`), `${JSON.stringify(record)}\n`);
    store.setChatLink(chatId, {
      parentChatId: 'parent',
      groupIndex,
      createdAt: '2026-09-25T10:00:00.000Z',
    });
  }

  async function list(): Promise<Map<string, ChatSummary>> {
    const response = await app.inject({ method: 'GET', url: '/api/chats' });
    expect(response.statusCode).toBe(200);
    return new Map(response.json<ChatSummary[]>().map((chat) => [chat.id, chat]));
  }

  it('вопрос текстом — «ждёт вас», принятая группа — «принято», прочие без меток', async () => {
    child('g-ask', 0);
    child('g-done', 1);
    child('g-quiet', 2);
    store.setSplitPlan({
      parentChatId: 'parent',
      projectPath: join(root, 'work'),
      createdAt: '2026-09-25T10:00:00.000Z',
      order: [0, 1, 2],
      request: {},
      proposal: { groups: [] },
      groups: [
        { index: 0, status: 'running', chatId: 'g-ask' },
        { index: 1, status: 'done', chatId: 'g-done', acceptedAt: '2026-09-25T11:00:00.000Z' },
        { index: 2, status: 'done', chatId: 'g-quiet' },
      ],
    } as unknown as SplitPlanRecord);
    asks.finished({
      chatId: 'g-ask',
      sessionId: 'g-ask',
      text: 'Сделал половину.\n\nКакую ветку взять за основу?',
      ok: true,
      startedAt: 0,
      options: { prompt: '', cwd: '/copy' },
      contextTokens: 0,
    });

    const chats = await list();

    expect(chats.get('g-ask')).toMatchObject({ awaitsYou: true });
    expect(chats.get('g-ask')?.accepted).toBeUndefined();
    expect(chats.get('g-done')).toMatchObject({ accepted: true });
    expect(chats.get('g-done')?.awaitsYou).toBeUndefined();
    expect(chats.get('g-quiet')?.awaitsYou).toBeUndefined();
    expect(chats.get('g-quiet')?.accepted).toBeUndefined();
  });

  // Живой прогон 25.09 (третий): группа, чья цепочка ушла в продолжение,
  // помнит чат черновым ключом `new-…`, а список — настоящим id; «принято» и
  // «в работе» по строгому равенству ключей терялись.
  it('группа помнит чат черновым ключом того же разговора — метки всё равно на нём', async () => {
    child('g-real', 0);
    store.setChatLink('new-7', {
      parentChatId: 'parent',
      groupIndex: 0,
      createdAt: '2026-09-25T10:00:00.000Z',
    });
    store.setSplitPlan({
      parentChatId: 'parent',
      projectPath: join(root, 'work'),
      createdAt: '2026-09-25T10:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [] },
      groups: [
        { index: 0, status: 'done', chatId: 'new-7', acceptedAt: '2026-09-25T11:00:00.000Z' },
      ],
    } as unknown as SplitPlanRecord);

    const chats = await list();

    expect(chats.get('g-real')).toMatchObject({ accepted: true });
  });

  /**
   * «Группы разделения в работе — наверх» (владелец, 24.09): между стадиями
   * конвейера живого прогона нет, и поднять ветку можно только по плану.
   */
  it('разделение в работе: метка у родителя и у идущей группы; очередь, итог и отмена — без', async () => {
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'parent.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u-parent',
        sessionId: 'parent',
        cwd: join(root, 'work'),
        timestamp: '2026-09-25T09:00:00.000Z',
        message: { role: 'user', content: 'Раздели задачи' },
      })}\n`,
    );
    child('g-work', 0);
    child('g-queued', 1);
    child('g-done', 2);
    const plan = {
      parentChatId: 'parent',
      projectPath: join(root, 'work'),
      createdAt: '2026-09-25T10:00:00.000Z',
      order: [0, 1, 2],
      request: {},
      proposal: { groups: [] },
      groups: [
        { index: 0, status: 'background', chatId: 'g-work' },
        { index: 1, status: 'waiting', chatId: 'g-queued' },
        { index: 2, status: 'done', chatId: 'g-done' },
      ],
    } as unknown as SplitPlanRecord;
    store.setSplitPlan(plan);

    const chats = await list();

    expect(chats.get('parent')?.inWork).toBe(true);
    expect(chats.get('g-work')?.inWork).toBe(true);
    expect(chats.get('g-queued')?.inWork).toBeUndefined();
    expect(chats.get('g-done')?.inWork).toBeUndefined();

    store.setSplitPlan({ ...plan, cancelledAt: '2026-09-25T12:00:00.000Z' });
    expect((await list()).get('parent')?.inWork).toBeUndefined();
  });

  // F5.2: новое разделение того же разговора затирало запись плана целиком —
  // принятая группа прошлого плана теряла «принято», а её копия оставалась без
  // кнопки уборки. Старые группы переживают новый план как `retiredGroups`.
  it('группа прошлого разделения: «принято» и неубранная копия живут после нового плана', async () => {
    child('old-accepted', 0);
    child('old-copy', 1);
    child('old-clean', 2);
    // Чат группы старого плана помнится черновым ключом того же разговора.
    store.setChatLink('new-9', {
      parentChatId: 'parent',
      groupIndex: 1,
      conversation: 'old-copy-talk',
      createdAt: '2026-09-25T10:00:00.000Z',
    });
    store.setChatLink('old-copy', {
      parentChatId: 'parent',
      groupIndex: 1,
      conversation: 'old-copy-talk',
      createdAt: '2026-09-25T10:00:00.000Z',
    });
    const previous = {
      parentChatId: 'parent',
      projectPath: join(root, 'work'),
      createdAt: '2026-09-25T10:00:00.000Z',
      order: [0, 1, 2],
      request: {},
      proposal: { groups: [] },
      groups: [
        {
          index: 0,
          status: 'done',
          chatId: 'old-accepted',
          acceptedAt: '2026-09-25T11:00:00.000Z',
          path: join(root, 'copy-0'),
          cleaned: { at: '2026-09-25T11:30:00.000Z', branch: 'deleted' },
        },
        { index: 1, status: 'done', chatId: 'new-9', path: join(root, 'copy-1') },
        {
          index: 2,
          status: 'done',
          chatId: 'old-clean',
          path: join(root, 'copy-2'),
          cleaned: { at: '2026-09-25T11:30:00.000Z', branch: 'deleted' },
        },
      ],
    } as unknown as SplitPlanRecord;
    for (const key of ['old-accepted', 'old-copy', 'new-9', 'old-clean']) {
      store.retireChatLink(key);
    }
    child('fresh', 0);
    store.setSplitPlan({
      ...previous,
      createdAt: '2026-09-25T12:00:00.000Z',
      groups: [{ index: 0, status: 'done', chatId: 'fresh' }],
      retiredGroups: retiredGroupsOf(previous),
    } as unknown as SplitPlanRecord);

    const chats = await list();

    expect(chats.get('old-accepted')).toMatchObject({ retired: true, accepted: true });
    expect(chats.get('old-accepted')?.copyLeft).toBeUndefined();
    expect(chats.get('old-copy')).toMatchObject({ retired: true, copyLeft: true });
    expect(chats.get('old-copy')?.accepted).toBeUndefined();
    expect(chats.get('old-clean')?.copyLeft).toBeUndefined();
    expect(chats.get('old-clean')?.accepted).toBeUndefined();
    // Новая группа с тем же номером не наследует ничего от старой.
    expect(chats.get('fresh')?.accepted).toBeUndefined();
    expect(chats.get('fresh')?.copyLeft).toBeUndefined();
  });

  // Живой прогон 25.09: MR группы был виден только в хабе родителя — в списке
  // чатов по строке группы не понять, дошла ли она до MR.
  it('MR группы — у её строки; группа с доставкой без MR — «MR нет», без доставки — ничего', async () => {
    child('g-mr', 0);
    child('g-wait', 1);
    child('g-plain', 2);
    store.setSplitPlan({
      parentChatId: 'parent',
      projectPath: join(root, 'work'),
      createdAt: '2026-09-25T10:00:00.000Z',
      order: [0, 1, 2],
      request: {},
      proposal: { groups: [] },
      groups: [
        {
          index: 0,
          status: 'done',
          chatId: 'g-mr',
          deliver: true,
          mr: 'https://tracker.example.com/proj/-/merge_requests/826',
        },
        { index: 1, status: 'running', chatId: 'g-wait', deliver: true },
        { index: 2, status: 'done', chatId: 'g-plain' },
      ],
    } as unknown as SplitPlanRecord);

    const chats = await list();

    expect(chats.get('g-mr')).toMatchObject({
      mergeRequest: 'https://tracker.example.com/proj/-/merge_requests/826',
    });
    expect(chats.get('g-mr')?.mergeRequestPending).toBeUndefined();
    expect(chats.get('g-wait')).toMatchObject({ mergeRequestPending: true });
    expect(chats.get('g-wait')?.mergeRequest).toBeUndefined();
    expect(chats.get('g-plain')?.mergeRequest).toBeUndefined();
    expect(chats.get('g-plain')?.mergeRequestPending).toBeUndefined();
  });
});
