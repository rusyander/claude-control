import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessagesPage, ChatSummary } from '@agentdeck/contracts';
import type { SessionStreamPage } from '@agentdeck/contracts/core/session-stream';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  coreChatBookPath,
  createCoreChatBook,
} from '../../../domains/chat/core-run/core-chat-book.ts';
import { createCoreChatHistory } from '../../../domains/chat/core-run/core-chat-history.ts';
import { registerChatTranscriptRoutes } from './transcript-routes.ts';

/**
 * Разговор не-Claude CLI в маршрутах чата (этап 11, волна 3): список, лента, опрос и выгрузка
 * читают его из видов сеансов ядра, разговор Claude — из транскрипта, как прежде. Маршрут, книга и
 * свёртка настоящие; ядро — подставной порт с видом задачи и страницей сеанса.
 */
describe('transcript routes — a non-Claude conversation from the core views', () => {
  let root: string;
  let app: FastifyInstance;
  const T = 1_793_989_152_846;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-core-history-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const ctx = {
      store: new AppStore(appData),
      location: { paths: { root, appData } },
      pricing: { current: () => ({ entries: [] }) },
    } as unknown as ServerContext;
    const book = createCoreChatBook(coreChatBookPath(appData));
    book.set('qwen-conv', { taskId: 't1', stepId: 'st', cli: 'qwen', cwd: join(root, 'work') });
    // Разговор Claude в книге — его лента всё равно из транскрипта.
    book.set('claude-conv', { taskId: 'tc', stepId: 'st', cli: 'claude', cwd: join(root, 'work') });
    const events = [
      { offset: 0, kind: 'user-text', data: { text: 'ист-1: qwen', sentAt: T } },
      { offset: 10, kind: 'assistant-text', data: { text: 'готов' } },
      { offset: 20, kind: 'turn-end', data: { isError: false } },
      { offset: 30, kind: 'user-text', data: { text: 'ист-2: qwen', sentAt: T + 60_000 } },
      { offset: 40, kind: 'assistant-text', data: { text: 'готов' } },
      { offset: 50, kind: 'turn-end', data: { isError: false } },
    ];
    const history = createCoreChatHistory(
      {
        view: async (taskId) =>
          taskId === 't1'
            ? ({
                taskId,
                seq: 3,
                ended: null,
                sessions: [
                  {
                    sessionId: 's1',
                    stepId: 'st',
                    startedSeq: 1,
                    modelAsked: 'qwen3',
                    modelServed: null,
                  },
                ],
              } as unknown as TaskView)
            : null,
        page: async (taskId, sessionId) =>
          ({
            taskId,
            sessionId,
            adapter: 'qwen',
            events,
            next: 60,
            done: false,
          }) as unknown as SessionStreamPage,
      },
      () => coreChatBookPath(appData),
    );
    app = Fastify();
    registerChatTranscriptRoutes(app, ctx, undefined, undefined, undefined, history);
    await app.ready();
    transcript('claude-conv', '2026-11-07T10:00:00.000Z');
    transcript('old-claude', '2026-10-01T10:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  function transcript(chatId: string, timestamp: string): void {
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const record = {
      type: 'user',
      uuid: `u-${chatId}`,
      sessionId: chatId,
      cwd: join(root, 'work'),
      timestamp,
      message: { role: 'user', content: `Задача ${chatId}` },
    };
    writeFileSync(join(dir, `${chatId}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  it('the list carries the non-Claude conversation in its folder, beside transcript chats', async () => {
    const chats = (await app.inject({ url: '/api/chats' })).json<ChatSummary[]>();
    const qwen = chats.find((c) => c.id === 'qwen-conv');
    expect(qwen).toMatchObject({
      title: 'ист-1: qwen',
      projectPath: join(root, 'work'),
      messageCount: 4,
      model: 'qwen3',
      updatedAt: new Date(T + 60_000).toISOString(),
    });
    expect(chats.map((c) => c.id).sort()).toEqual(['claude-conv', 'old-claude', 'qwen-conv']);
    expect(chats.filter((c) => c.id === 'claude-conv')).toHaveLength(1);
  });

  it('the project list (the phone reads chats from it) carries the non-Claude conversation in its folder, once', async () => {
    const projects = (await app.inject({ url: '/api/chats/projects' })).json<
      Array<{ path: string; chats: Array<{ id: string; title: string; messageCount: number }> }>
    >();
    const work = projects.find((p) => p.path === join(root, 'work'));
    // Порядок у транскриптов — по времени файла (оба записаны сейчас), поэтому сверка без порядка.
    expect(work?.chats.map((c) => c.id).sort()).toEqual(['claude-conv', 'old-claude', 'qwen-conv']);
    expect(work?.chats.find((c) => c.id === 'qwen-conv')).toMatchObject({
      title: 'ист-1: qwen',
      messageCount: 4,
    });
    // Есть и транскрипт с тем же id (разговор начинал Claude) — строка одна, транскриптная.
    transcript('qwen-conv', '2026-11-07T11:00:00.000Z');
    const again = (await app.inject({ url: '/api/chats/projects' })).json<
      Array<{ path: string; chats: Array<{ id: string; messageCount: number }> }>
    >();
    const twice = again.find((p) => p.path === join(root, 'work'))?.chats;
    expect(twice?.filter((c) => c.id === 'qwen-conv')).toEqual([
      expect.objectContaining({ messageCount: 1 }),
    ]);
  });

  it('the feed and the poll of the non-Claude conversation come from the core; Claude stays on its transcript', async () => {
    const page = (
      await app.inject({ url: '/api/chats/qwen-conv/messages?limit=3' })
    ).json<ChatMessagesPage>();
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(page.messages[0]!.timestamp).toBe(new Date(T).toISOString());
    const claude = (
      await app.inject({ url: '/api/chats/claude-conv/messages' })
    ).json<ChatMessagesPage>();
    expect(claude.messages.map((m) => m.id)).toEqual(['u-claude-conv']);
    expect((await app.inject({ url: '/api/chats/qwen-conv/version' })).json()).toEqual({
      mtimeMs: T + 60_000,
      size: 60,
    });
    expect((await app.inject({ url: '/api/chats/nobody/version' })).json()).toEqual({
      mtimeMs: 0,
      size: 0,
    });
  });

  it('the export of the non-Claude conversation carries its turns and title', async () => {
    const res = await app.inject({ url: '/api/chat/qwen-conv/export?format=md' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ист-1: qwen');
    expect(res.body).toContain('ист-2: qwen');
    expect(res.body).toContain('готов');
  });
});
