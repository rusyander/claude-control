import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunInputsResponse } from '@agentdeck/contracts/run-input';
import type { ServerContext } from '../../context.ts';
import { appendRunInput } from '../../domains/chat/run-input/run-input.ts';
import { registerChatCascadeRoutes } from './cascade-routes.ts';

/**
 * Маршрут «Что получил агент» (U8) на настоящем Fastify: ключ чужого CLI с
 * двоеточием приходит закодированным, как его шлёт веб, и читается обратно.
 */
describe('GET /api/chat/:chatId/received', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-received-'));
    app = Fastify();
    registerChatCascadeRoutes(app, {
      location: { paths: { appData: dir } },
    } as unknown as ServerContext);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('отдаёт входы прогонов свежими первыми, ключ чужого CLI — закодированным', async () => {
    appendRunInput(dir, 'codex:abc', { startedAt: 1, prompt: 'первый' });
    appendRunInput(dir, 'codex:abc', { startedAt: 2, prompt: 'второй', model: 'gpt' });

    const response = await app.inject({
      method: 'GET',
      url: `/api/chat/${encodeURIComponent('codex:abc')}/received`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<RunInputsResponse>();
    expect(body.runs.map((run) => run.prompt)).toEqual(['второй', 'первый']);
    expect(body.runs[0]?.model).toBe('gpt');
  });

  it('разговор без записей — пустой список, а не ошибка; чужие записи не подмешиваются', async () => {
    appendRunInput(dir, 'codex:abc', { startedAt: 1, prompt: 'соседний разговор' });

    const response = await app.inject({ method: 'GET', url: '/api/chat/sess-1/received' });

    expect(response.statusCode).toBe(200);
    expect(response.json<RunInputsResponse>()).toEqual({ runs: [] });
  });
});
