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

/**
 * Битое тело мутирующего маршрута чата — 400 с именем поля, а не 500 из глубины
 * домена. Реестр здесь считает запуски: ни один отказ до него не доходит.
 */
describe('тела маршрутов чата проверяются на входе', () => {
  let root: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  let started = 0;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-body-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    started = 0;
    registry = new ChatRunRegistry((): RunLike => {
      started++;
      return { start: () => new Promise(() => undefined), stop: () => undefined };
    });
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

  const fields = (res: { json: () => { issues?: { path: string }[] } }): string[] =>
    (res.json().issues ?? []).map((issue) => issue.path);

  it('отправка: нет chatId, files не массив — 400 с именами полей, агент не запущен', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { prompt: 'привет', files: 'a.txt' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_body');
    expect(fields(res)).toEqual(['chatId', 'files']);
    expect(started).toBe(0);
  });

  it('отправка: вложение без имени — 400 с путём до самого поля', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'c1', prompt: 'x', files: [{ base64: 'AA==' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(fields(res)).toEqual(['files.0.name']);
    expect(started).toBe(0);
  });

  it('решение по правам: behavior вне allow/deny — 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/c1/permission-decision',
      payload: { toolUseId: 't1', behavior: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
    expect(fields(res)).toEqual(['behavior']);
  });

  it('запрос прав без runId — 400, а не подвисший ответ', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { toolName: 'Bash', input: {}, toolUseId: 't' },
    });
    expect(res.statusCode).toBe(400);
    expect(fields(res)).toEqual(['runId']);
  });

  it('тумблер автоподтверждения: строка вместо boolean — 400, без тела — выключено', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/chat/c1/auto-approve',
      payload: { enabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    expect(fields(bad)).toEqual(['enabled']);

    const empty = await app.inject({ method: 'POST', url: '/api/chat/c1/auto-approve' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ ok: true });
  });
});
