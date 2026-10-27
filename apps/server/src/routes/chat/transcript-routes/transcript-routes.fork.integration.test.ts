import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatSummary } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../../../domains/chat/ChatRunner/ChatRunner.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { registerChatRoutes } from '../../chat-routes/chat-routes.ts';

/**
 * Ветка правки своей реплики в списке чатов (Telegram 26.10, R2). Карандаш
 * «Изменить и отправить в новой ветке» шлёт `fork: true`, CLI с
 * `--fork-session` называет НОВУЮ сессию, и её транскрипт несёт всю историю
 * исходного и то же название — в списке стояли два одинаковых чата.
 *
 * Маршруты отправки и списка настоящие, реестр и хранилище тоже; слушатель
 * сессии собран как в `runtime.ts` (`store.linkChatSession`). Подменён только
 * CLI: он называет сессию и кладёт транскрипт, как настоящий.
 */
describe('список чатов: ветка правки реплики', () => {
  let root: string;
  let data: string;
  let work: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let runs: { options: RunOptions; end: () => void }[];
  const ORIGIN = 'origin-session';
  const TITLE = 'Перенеси настройки на второй компьютер';

  const transcript = (sessionId: string, text = TITLE): void => {
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const record = {
      type: 'user',
      uuid: `u-${sessionId}`,
      sessionId,
      cwd: work,
      timestamp: '2026-10-26T10:00:00.000Z',
      message: { role: 'user', content: text },
    };
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-chat-fork-'));
    data = join(root, 'agentdeck');
    work = join(root, 'work');
    mkdirSync(data, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    runs = [];
    store = new AppStore(data);
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent: (event: ChatEvent) => void) =>
        new Promise<void>((resolve) => {
          const session = options.fork
            ? `fork-${runs.length}`
            : (options.sessionId ?? `fresh-${runs.length}`);
          // Ветка несёт историю исходного — то же первое слово человека.
          transcript(session);
          onEvent({ kind: 'session', sessionId: session, model: '', tools: 0 });
          runs.push({ options, end: resolve });
        }),
      stop: () => undefined,
    }));
    // Как в `runtime.ts`: смена ключа разговора уходит в хранилище.
    registry.setSessionListener((chatId, sessionId, from) =>
      store.linkChatSession(chatId, sessionId, from),
    );
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          mcpConfig: join(root, '.claude.json'),
          appData: data,
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRoutes(app, ctx, registry, new ChatSession(registry, data));
    await app.ready();
    transcript(ORIGIN);
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const tick = (ms = 40) => new Promise((done) => setTimeout(done, ms));

  /** Как вкладка исходного разговора: ключ чата и сессия — его id. */
  const send = async (fork: boolean): Promise<void> => {
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: {
        chatId: ORIGIN,
        sessionId: ORIGIN,
        prompt: 'Перенеси настройки на второй и третий компьютер',
        projectPath: work,
        allowEdits: true,
        fork,
      },
    });
    await tick();
    runs.at(-1)?.end();
    await tick();
  };

  async function list(): Promise<Map<string, ChatSummary>> {
    const response = await app.inject({ method: 'GET', url: '/api/chats' });
    expect(response.statusCode).toBe(200);
    return new Map(response.json<ChatSummary[]>().map((chat) => [chat.id, chat]));
  }

  it('ветка подписана исходным разговором, исходный — нет; запись переживает перезапуск', async () => {
    await send(true);
    expect(runs[0]?.options.fork).toBe(true);

    const chats = await list();
    const fork = chats.get('fork-0');
    expect(fork?.title).toBe(chats.get(ORIGIN)?.title);
    expect(fork?.forkOf).toEqual({ id: ORIGIN, title: TITLE });
    expect(chats.get(ORIGIN)?.forkOf).toBeUndefined();

    const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
    expect(state.chatForks).toEqual({ 'fork-0': ORIGIN });
    // Новое хранилище над тем же каталогом — как панель после перезапуска.
    expect(new AppStore(data).getChatForks()).toEqual({ 'fork-0': ORIGIN });
  });

  it('исходного в списке нет — ветка всё равно подписана, без названия', async () => {
    await send(true);
    rmSync(join(root, 'projects', 'proj', `${ORIGIN}.jsonl`));

    expect((await list()).get('fork-0')?.forkOf).toEqual({ id: ORIGIN });
  });

  it('продолжение того же разговора веткой не становится', async () => {
    await send(false);

    const chats = await list();
    expect([...chats.keys()]).toEqual([ORIGIN]);
    expect(chats.get(ORIGIN)?.forkOf).toBeUndefined();
    expect(store.getChatForks()).toEqual({});
  });
});
