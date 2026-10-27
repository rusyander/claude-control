import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../../context.ts';
import { resetAgentDigestCache } from '../../../domains/chat/subagent-tree/agent-digest.ts';
import { resetAgentHistoryCache } from '../../../domains/chat/agent-history/agent-history.ts';
import {
  appendSubagentCall,
  seedGroup,
  type GroupFixture,
} from '../../../domains/chat/agent-history/agent-history.fixture.ts';
import { registerSubagentRoutes } from './subagent-routes.ts';

/**
 * `GET /api/chat/:chatId/agent-history` через настоящий маршрут Fastify:
 * связи групп — из хранилища панели, транскрипты — файлы во временном каталоге.
 */
describe('маршрут истории агентов', () => {
  let root: string;
  let fx: GroupFixture;
  let app: FastifyInstance;

  beforeEach(async () => {
    resetAgentHistoryCache();
    resetAgentDigestCache();
    root = mkdtempSync(join(tmpdir(), 'cc-agent-history-route-'));
    fx = seedGroup(root);
    const ctx = {
      location: { paths: { root } },
      store: { getChatLinks: () => fx.links },
    } as unknown as ServerContext;
    app = Fastify();
    registerSubagentRoutes(app, ctx, { stopSubagent: () => Promise.resolve('absent') });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('отдаёт все сессии группы; тот же ответ — 304 по ETag, дописанный субагент — новое тело', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/chat/s-fix/agent-history' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      agentCount: 3,
      sessions: [
        { chatId: 's-fix', current: true },
        { chatId: 's-work', stage: 'work' },
      ],
    });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\//);
    const same = await app.inject({
      method: 'GET',
      url: '/api/chat/s-fix/agent-history',
      headers: { 'if-none-match': etag },
    });
    expect(same.statusCode).toBe(304);
    appendSubagentCall(fx.workLog, 3);
    const grown = await app.inject({
      method: 'GET',
      url: '/api/chat/s-fix/agent-history',
      headers: { 'if-none-match': etag },
    });
    expect(grown.statusCode).toBe(200);
  });

  it('разговора нет — пустая история, не ошибка', async () => {
    const none = await app.inject({ method: 'GET', url: '/api/chat/nope/agent-history' });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ sessions: [], agentCount: 0, live: { agents: 0, subagents: 0 } });
  });

  it('«сейчас работают» спрашивает реестр процессов по ключам сессии', async () => {
    await app.close();
    const alive: string[] = [];
    const ctx = {
      location: { paths: { root } },
      store: { getChatLinks: () => fx.links },
    } as unknown as ServerContext;
    app = Fastify();
    registerSubagentRoutes(app, ctx, {
      stopSubagent: () => Promise.resolve('absent'),
      isProcessAlive: (chatId) => {
        alive.push(chatId);
        return chatId === 's-fix';
      },
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/chat/s-work/agent-history' });
    expect(res.json().live).toEqual({ agents: 1, subagents: 1 });
    expect(alive).toContain('s-fix');
  });

  it('ход главного агента любой сессии — окном шагов; нет разговора — 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat/s-work/main-agent?limit=2' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      agentId: 'main',
      // Шаги s-work: Agent, Agent, Bash, реплика «Готово»; окно — последние два.
      total: 4,
      start: 2,
      hasMore: true,
      toolCalls: 3,
    });
    expect(
      body.steps.map((step: { name?: string; kind: string }) => step.name ?? step.kind),
    ).toEqual(['Bash', 'text']);
    const from = await app.inject({
      method: 'GET',
      url: '/api/chat/s-work/main-agent?start=0&limit=1',
    });
    expect(from.json()).toMatchObject({ start: 0, hasMore: false, steps: [{ name: 'Agent' }] });
    const none = await app.inject({ method: 'GET', url: '/api/chat/nope/main-agent' });
    expect(none.statusCode).toBe(404);
  });
});
