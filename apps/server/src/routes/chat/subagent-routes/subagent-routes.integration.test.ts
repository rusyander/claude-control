import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../../context.ts';
import { resetAgentDigestCache } from '../../../domains/chat/subagent-tree/agent-digest.ts';
import { registerSubagentRoutes } from './subagent-routes.ts';

/**
 * Ход субагента через настоящий маршрут Fastify. Транскрипт — файлы на диске в
 * раскладке CLI.
 */
describe('маршруты субагента', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    resetAgentDigestCache();
    root = mkdtempSync(join(tmpdir(), 'cc-subagent-routes-'));
    const agents = join(root, 'projects', 'proj', 'sess', 'subagents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(root, 'projects', 'proj', 'sess.jsonl'), '');
    writeFileSync(
      join(agents, 'agent-a1b2.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'Найти' }),
    );
    const steps = Array.from({ length: 3 }, (_, index) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id: `m${index}`,
          content: [
            { type: 'tool_use', id: `t${index}`, name: 'Grep', input: { pattern: `p${index}` } },
          ],
        },
      }),
    );
    writeFileSync(join(agents, 'agent-a1b2.jsonl'), `${steps.join('\n')}\n`);
    const ctx = { location: { paths: { root } } } as unknown as ServerContext;
    app = Fastify();
    registerSubagentRoutes(app, ctx, {});
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET отдаёт окно шагов; limit и offset считаются от конца', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/chat/sess/agents/a1b2' });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({
      agentId: 'a1b2',
      kind: 'Explore',
      total: 3,
      hasMore: false,
    });
    const window = await app.inject({
      method: 'GET',
      url: '/api/chat/sess/agents/a1b2?limit=1&offset=1',
    });
    const body = window.json<{ steps: Array<{ summary: string }>; hasMore: boolean }>();
    expect(body.steps.map((step) => step.summary)).toEqual(['p1']);
    expect(body.hasMore).toBe(true);
  });

  it('GET extensions: главный агент и субагент; id-путь — 400, чужой — 404', async () => {
    writeFileSync(
      join(root, 'projects', 'proj', 'sess.jsonl'),
      `${JSON.stringify({
        type: 'attachment',
        timestamp: '2026-10-25T10:00:00.000Z',
        attachment: {
          type: 'hook_success',
          hookName: 'Stop',
          command: 'node stop-guard.mjs',
          durationMs: 12,
        },
      })}\n`,
    );
    const main = await app.inject({ method: 'GET', url: '/api/chat/sess/extensions' });
    expect(main.statusCode).toBe(200);
    expect(main.json()).toMatchObject({
      total: 1,
      items: [{ kind: 'hook', name: 'stop-guard', durationMs: 12, outcome: 'ok' }],
      summary: [{ kind: 'hook', name: 'stop-guard', count: 1 }],
    });
    const sub = await app.inject({ method: 'GET', url: '/api/chat/sess/agents/a1b2/extensions' });
    expect(sub.statusCode).toBe(200);
    expect(sub.json()).toEqual({ agentId: 'a1b2', items: [], total: 0, summary: [] });
    const bad = await app.inject({ method: 'GET', url: '/api/chat/sess/agents/a.b/extensions' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ messageCode: 'agent-id-invalid' });
    const missing = await app.inject({ method: 'GET', url: '/api/chat/sess/agents/zz/extensions' });
    expect(missing.statusCode).toBe(404);
    const noChat = await app.inject({ method: 'GET', url: '/api/chat/none/extensions' });
    expect(noChat.statusCode).toBe(404);
    expect(noChat.json()).toMatchObject({ messageCode: 'conversation-not-found' });
  });

  it('GET: id-путь — 400, чужой — 404', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/chat/sess/agents/..%2F..%2Fx' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ messageCode: 'agent-id-invalid' });
    const missing = await app.inject({ method: 'GET', url: '/api/chat/sess/agents/ffff' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ messageCode: 'agent-not-found' });
  });

  it('остановки субагента нет: POST stop — 404 (stdin у CLI держит ядро, не панель)', async () => {
    const stop = await app.inject({ method: 'POST', url: '/api/chat/sess/agents/a1b2/stop' });
    expect(stop.statusCode).toBe(404);
  });
});
