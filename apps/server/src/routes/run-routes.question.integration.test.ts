import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatRoutes } from './chat-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { QUESTION_DENIED } from '../domains/chat/initiative.ts';

/**
 * Вопрос человеку, пришедший брокеру прав как запрос на разрешение.
 *
 * Живьём (05.09.2026, claude 2.1.177) вызов `AskUserQuestion` доходит до
 * `--permission-prompt-tool`, и без ответа брокера прогон стоит до получаса —
 * рядом с карточкой вопроса висела карточка прав, а выбор человека ждал в
 * очереди, пока кто-нибудь не нажмёт «Запретить». Отклонять этот запрос
 * обязан сам брокер, сразу и без карточки: ответ едет следующим сообщением.
 */
describe('POST /api/chat/permission-request: вопрос человеку', () => {
  let root: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;

  /** Собрать буфер событий прогона — то, что видит лента. */
  const eventsOf = (chatId: string): string[] => {
    const kinds: string[] = [];
    registry.attach(chatId, 0, { send: (b) => kinds.push(b.event.kind), close: () => undefined });
    return kinds;
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-question-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    // Прогон, который не заканчивается сам: как настоящий, ждущий брокера.
    registry = new ChatRunRegistry((): RunLike => ({
      start: () => new Promise(() => undefined),
      stop: () => undefined,
    }));
    const store = new AppStore(join(root, 'claude-control'));
    const ctx = { location: { paths: { root } }, store } as unknown as ServerContext;

    app = Fastify();
    registerChatRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Ответ на отправку — сам поток прогона, а прогон здесь не кончается: ждём
   * не ответа, а регистрации.
   */
  const startRun = async (prompt: string): Promise<void> => {
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'q-run', prompt },
    });
    await new Promise((done) => setTimeout(done, 30));
  };

  const ask = (toolName: string) =>
    app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: {
        runId: 'q-run',
        toolName,
        input: { questions: [{ question: 'Какой вариант?', options: [] }] },
        toolUseId: 'toolu_q',
      },
    });

  it('отклоняется сразу, с текстом для агента, и карточки прав в потоке нет', async () => {
    await startRun('спроси меня');

    const res = await ask('AskUserQuestion');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ behavior: 'deny', message: QUESTION_DENIED });
    expect(eventsOf('q-run')).not.toContain('permission');
  });

  it('обычный инструмент по-прежнему ждёт человека карточкой', async () => {
    await startRun('сделай');

    // Ответ придёт только после решения — не ждём его, смотрим на поток.
    const pending = ask('Bash');
    await new Promise((done) => setTimeout(done, 20));
    expect(eventsOf('q-run')).toContain('permission');

    await app.inject({
      method: 'POST',
      url: '/api/chat/q-run/permission-decision',
      payload: { toolUseId: 'toolu_q', behavior: 'deny' },
    });
    expect((await pending).json().behavior).toBe('deny');
  });
});
