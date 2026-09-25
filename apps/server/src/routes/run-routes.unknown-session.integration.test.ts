import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatRoutes } from './chat-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';

/**
 * Отправка с `sessionId`, которого нет. Живой прогон 24.09.2026: сообщение с
 * `sessionId: ".jsonl"` в чат группы завело под тем же chatId свежую сессию без
 * истории, а UUID без транскрипта кончался голым «Запрос не выполнен».
 *
 * Заглушен один слой — процесс CLI; маршрут, разбор тела, поиск транскрипта в
 * каталоге конфигурации и реестр прогонов настоящие.
 */
describe('POST /api/chat/send: неизвестный sessionId', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let started: { cwd: string; sessionId?: string }[];
  const KNOWN = '6f1c2a3b-0000-4000-8000-00000000abcd';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-unknown-session-'));
    project = mkdtempSync(join(tmpdir(), 'cc-unknown-session-proj-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'projects', 'enc-proj'), { recursive: true });
    writeFileSync(
      join(root, 'projects', 'enc-proj', `${KNOWN}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-09-24T10:00:00.000Z',
        cwd: project,
        message: { role: 'user', content: 'первое' },
      }) + '\n',
    );

    started = [];
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({
          cwd: options.cwd,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        });
      },
      stop: () => undefined,
    }));
    const store = new AppStore(join(root, 'agentdeck'));
    const ctx = { location: { paths: { root } }, store } as unknown as ServerContext;

    app = Fastify();
    registerChatRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const send = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/chat/send', payload });

  it('имя-огрызок и UUID без транскрипта — отказ с причиной, прогон не заводится', async () => {
    for (const sessionId of ['.jsonl', '0b1e7c3e-0000-4000-8000-000000000000', `../${KNOWN}`]) {
      const res = await send({ chatId: 'group-chat', prompt: 'продолжай', sessionId });
      expect({ sessionId, status: res.statusCode }).toEqual({ sessionId, status: 404 });
      const body = res.json() as { code?: string; message?: string; sessionId?: string };
      expect(body.code).toBe('session_unknown');
      expect(body.message).toContain(`Разговор ${sessionId} не найден`);
      expect(body.sessionId).toBe(sessionId);
    }
    expect(started).toEqual([]);
  });

  it('разговор с транскриптом продолжается в своём каталоге, новый — без sessionId', async () => {
    await send({ chatId: KNOWN, prompt: 'второе', sessionId: KNOWN });
    await send({ chatId: 'new-1', prompt: 'новый', projectPath: project });
    // Пустая строка — «сессии нет», как было: отказом она не встречается.
    await send({ chatId: 'new-2', prompt: 'ещё новый', projectPath: project, sessionId: '' });
    expect(started).toEqual([
      { cwd: project, sessionId: KNOWN },
      { cwd: project },
      { cwd: project },
    ]);
  });
});
