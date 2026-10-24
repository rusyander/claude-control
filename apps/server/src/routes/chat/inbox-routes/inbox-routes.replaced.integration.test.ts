import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatInbox } from '@agentdeck/contracts/chat-inbox';
import { chatInboxSchema } from '@agentdeck/contracts/chat-inbox';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import {
  translate,
  type ChatEvent,
  type RawEvent,
} from '../../../domains/chat/ChatRunner/ChatRunner.ts';
import { registerChatInboxRoutes } from './inbox-routes.ts';

/**
 * Живой случай 23.10: группа задала вопросы, её прогон умер (панель не
 * отвечала по сети), группу перезапустили — и остывшую сессию панель не
 * продолжила, а начала под тем же ключом НОВЫЙ разговор. Вопросы прежней сессии
 * остались неотвеченными в её транскрипте, и сводка телефона часами звала
 * «ждёт ответа» по разговору, которого уже никто не ведёт: ответ ушёл бы по
 * ключу в новый разговор, который этих вопросов не задавал.
 *
 * Путь настоящий: реестр, хранилище панели (синоним ключа пишет его слушатель
 * сессии, как в `runtime.ts`), чтение транскриптов и маршрут сводки; заглушен
 * только процесс CLI.
 */
describe('GET /api/chat/inbox — вопрос сменённой сессии', () => {
  const OLD = 'old-session';
  const NEW = 'new-session';
  const IDLE = 'idle-session';
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  let cliLine: (raw: RawEvent) => void = () => undefined;
  let finish: () => void = () => undefined;

  const liveRun = (): RunLike => ({
    start: (_options: unknown, onEvent: (event: ChatEvent) => void) => {
      cliLine = (raw) => {
        for (const event of translate(raw)) onEvent(event);
      };
      return new Promise<void>((done) => {
        finish = done;
      });
    },
    stop: () => finish(),
  });

  const transcriptOf = (session: string) =>
    join(root, 'projects', 'C--work-shop', `${session}.jsonl`);
  const line = (session: string, record: unknown) =>
    appendFileSync(transcriptOf(session), `${JSON.stringify(record)}\n`);

  /** Вопрос агента и отказ брокера панели — так `-p` оставляет его ждать ответа. */
  const askIn = (session: string, toolUseId: string) => {
    const at = new Date().toISOString();
    line(session, {
      type: 'user',
      uuid: `${session}-u0`,
      cwd: project,
      timestamp: at,
      message: { role: 'user', content: 'Сделай задачу группы' },
    });
    line(session, {
      type: 'assistant',
      uuid: `${session}-a1`,
      timestamp: at,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Что делать с ролью?', options: [{ label: 'A' }] }] },
          },
        ],
      },
    });
    line(session, {
      type: 'user',
      uuid: `${session}-u1`,
      timestamp: at,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: 'ответ придёт' },
        ],
      },
    });
    // Ход кончен словами «жду ответа» — как у живой группы: ждёт человека, не идёт.
    line(session, {
      type: 'assistant',
      uuid: `${session}-a2`,
      timestamp: at,
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Жду ответа на карточке.' }],
      },
    });
  };

  const inbox = async (): Promise<ChatInbox> => {
    const response = await app.inject({ method: 'GET', url: '/api/chat/inbox' });
    expect(response.statusCode).toBe(200);
    return chatInboxSchema.parse(response.json());
  };
  const asksOf = (seen: ChatInbox, id: string) =>
    seen.chats.find((chat) => chat.id === id)?.asks.map((ask) => ask.key);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-inbox-replaced-'));
    project = join(root, 'work', 'shop');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(root, 'projects', 'C--work-shop'), { recursive: true });
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    askIn(OLD, 'q-old');
    askIn(IDLE, 'q-idle');

    const store = new AppStore(join(root, 'agentdeck'));
    registry = new ChatRunRegistry(liveRun);
    // Та же проводка, что в `runtime.ts`: прогон назвал сессию — хранилище
    // переносит на неё ключ разговора.
    registry.setSessionListener((chatId, sessionId, from) =>
      store.linkChatSession(chatId, sessionId, from),
    );
    const session = new ChatSession(registry);
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
    } as unknown as ServerContext;
    app = Fastify();
    registerChatInboxRoutes(app, ctx, registry, session);
    await app.ready();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('новый разговор под тем же ключом снимает вопросы прежней сессии — и пока идёт, и после конца', async () => {
    // До перезапуска вопрос прежней сессии ждёт ответа — это и есть её карточка.
    expect(asksOf(await inbox(), OLD)).toEqual(['q:q-old:0']);

    // Перезапуск группы: остывшую сессию не продолжаем (`sessionId` снят),
    // CLI называет новую.
    registry.start(OLD, { prompt: 'Вводная панели', cwd: project }, { projectPath: project });
    cliLine({ type: 'system', subtype: 'init', session_id: NEW } as RawEvent);
    line(NEW, {
      type: 'user',
      uuid: 'n0',
      cwd: project,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Вводная панели' },
    });

    const running = await inbox();
    expect(running.chats.find((chat) => chat.id === NEW)).toMatchObject({
      runKey: OLD,
      status: 'running',
    });
    expect(asksOf(running, OLD)).toEqual([]);
    // Вопрос разговора, который никто не сменял, остаётся: ответ на него
    // продолжит его же сессию.
    expect(asksOf(running, IDLE)).toEqual(['q:q-idle:0']);

    // Прогон кончился — прежняя сессия от этого живой не становится.
    finish();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!registry.active().some((run) => run.status === 'running')) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    const ended = await inbox();
    expect(asksOf(ended, OLD)).toEqual([]);
    expect(ended.chats.find((chat) => chat.id === OLD)?.status).toBe('idle');
    expect(asksOf(ended, IDLE)).toEqual(['q:q-idle:0']);
  });
});
