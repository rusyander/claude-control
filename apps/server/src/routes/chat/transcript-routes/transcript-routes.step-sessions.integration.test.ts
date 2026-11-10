import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatSearchResponse, ChatSummary } from '@agentdeck/contracts';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { coreChatBookPath } from '../../../domains/chat/core-run/core-chat-book.ts';
import { createCoreChatHistory } from '../../../domains/chat/core-run/core-chat-history.ts';
import { createCoreStepSessions } from '../../../domains/chat/core-run/core-step-sessions.ts';
import { registerChatTranscriptRoutes } from './transcript-routes.ts';

/**
 * Сеансы, что ядро открыло под шаги задачи (разбор, план, работа), — не разговоры человека: их
 * транскрипты Claude лежат в `projects/` под id сеанса ядра, но списки чатов (вкладка, список
 * проектов телефона, поиск) их не показывают. Чат перехвата и чат через ядро (шаг `chat`) — в
 * списке. Маршруты, история и обход задач настоящие; ядро за HTTP — подставной порт.
 */
describe('transcript routes — core step sessions are not listed as conversations', () => {
  let root: string;
  let app: FastifyInstance;
  let up = true;
  let views = 0;
  const seq: Record<string, number> = { work: 5, takeover: 2 };

  const view = (taskId: string, steps: [string, string][], sessions: [string, string][]) =>
    ({
      taskId,
      seq: seq[taskId],
      ended: null,
      steps: steps.map(([stepId, stepKind]) => ({ stepId, stepKind })),
      sessions: sessions.map(([sessionId, stepId]) => ({ sessionId, stepId, startedSeq: 1 })),
    }) as unknown as TaskView;

  beforeEach(async () => {
    up = true;
    views = 0;
    root = mkdtempSync(join(tmpdir(), 'cc-step-sessions-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const ctx = {
      store: new AppStore(appData),
      location: { paths: { root, appData } },
      pricing: { current: () => ({ entries: [] }) },
    } as unknown as ServerContext;
    const port = {
      tasks: async () => {
        if (!up) throw new Error('core is not running');
        return [
          { taskId: 'work', seq: seq.work! },
          { taskId: 'takeover', seq: seq.takeover! },
        ];
      },
      view: async (taskId: string) => {
        views += 1;
        if (taskId === 'work')
          return view(
            'work',
            [
              ['st-intake', 'intake'],
              ['st-plan', 'plan'],
              ['st-work', 'work'],
            ],
            [
              ['step-intake', 'st-intake'],
              ['step-plan', 'st-plan'],
              ['step-work', 'st-work'],
            ],
          );
        if (taskId === 'takeover')
          return view('takeover', [['st-chat', 'chat']], [['takeover-chat', 'st-chat']]);
        return null;
      },
    };
    const history = createCoreChatHistory(
      { view: port.view, page: async () => ({ events: [], next: 0 }) as never },
      () => coreChatBookPath(appData),
      createCoreStepSessions(port),
    );
    app = Fastify();
    registerChatTranscriptRoutes(app, ctx, undefined, undefined, undefined, history);
    await app.ready();
    for (const id of ['step-intake', 'step-plan', 'step-work', 'takeover-chat', 'human-chat']) {
      transcript(id);
    }
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  function transcript(chatId: string): void {
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const record = {
      type: 'user',
      uuid: `u-${chatId}`,
      sessionId: chatId,
      cwd: join(root, 'repo'),
      timestamp: '2026-11-08T10:00:00.000Z',
      message: { role: 'user', content: `Задача ${chatId}` },
    };
    writeFileSync(join(dir, `${chatId}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  const listed = async () =>
    (await app.inject({ url: '/api/chats' }))
      .json<ChatSummary[]>()
      .map((c) => c.id)
      .sort();

  it('the chat list hides step sessions and keeps the takeover chat and the human chat', async () => {
    expect(await listed()).toEqual(['human-chat', 'takeover-chat']);
  });

  it('the project list (phone) and the full-text search hide them too', async () => {
    const projects = (await app.inject({ url: '/api/chats/projects' })).json<
      Array<{ path: string; chats: Array<{ id: string }> }>
    >();
    expect(projects.flatMap((p) => p.chats.map((c) => c.id)).sort()).toEqual([
      'human-chat',
      'takeover-chat',
    ]);
    const found = (
      await app.inject({ url: `/api/chat/search?q=${encodeURIComponent('Задача')}` })
    ).json<ChatSearchResponse>();
    expect(found.hits.map((h) => h.sessionId).sort()).toEqual(['human-chat', 'takeover-chat']);
  });

  it('an unchanged task is not re-read; a moved one is', async () => {
    await listed();
    expect(views).toBe(2);
    await listed();
    expect(views).toBe(2);
    seq.work = 6;
    await listed();
    expect(views).toBe(3);
  });

  it('core down: the last known step sessions stay hidden; never seen — nothing is hidden', async () => {
    await listed();
    up = false;
    expect(await listed()).toEqual(['human-chat', 'takeover-chat']);
  });

  it('core never answered: the list keeps every transcript (nothing to judge by)', async () => {
    up = false;
    expect(await listed()).toEqual([
      'human-chat',
      'step-intake',
      'step-plan',
      'step-work',
      'takeover-chat',
    ]);
  });
});
