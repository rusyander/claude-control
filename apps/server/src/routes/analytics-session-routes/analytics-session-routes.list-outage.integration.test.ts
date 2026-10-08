import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAnalyticsSessionRoutes } from './analytics-session-routes.ts';

/**
 * F-145b, «Перейти»: список процессов CLI не получен (таймаут CIM/`ps`, отказ
 * системы). Раньше отказ читался пустым списком, и сессия, идущая в терминале,
 * называлась «уже не идёт» — а «Перейти» открывало её разговор вторым писателем
 * в тот же транскрипт. Отказ списка — ответ «не удалось проверить», не догадка.
 *
 * Отказ настоящий: `powershell`/`ps` не находятся в пустом PATH.
 */

let app: FastifyInstance | undefined;
let dir = '';

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('GET /api/analytics/sessions/:id/where — список процессов не получен', () => {
  it('503 с кодом текста, а не «сессия завершилась»', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-where-outage-'));
    app = Fastify();
    registerAnalyticsSessionRoutes(app, { location: { paths: { root: dir } } } as never, {
      active: () => [],
    });
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    let response;
    try {
      response = await app.inject({
        method: 'GET',
        url: '/api/analytics/sessions/00000000-0000-0000-0000-000000000000/where',
      });
    } finally {
      process.env.PATH = savedPath;
    }
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ messageCode: 'session-processes-unavailable' });
  });

  it('прогон панели списку не подчинён — отвечает, где идёт', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-where-outage-'));
    const id = '11111111-2222-4333-8444-555555555555';
    app = Fastify();
    registerAnalyticsSessionRoutes(app, { location: { paths: { root: dir } } } as never, {
      active: () => [{ chatId: id, sessionId: id, status: 'running' }],
    });
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    let response;
    try {
      response = await app.inject({ method: 'GET', url: `/api/analytics/sessions/${id}/where` });
    } finally {
      process.env.PATH = savedPath;
    }
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ where: { kind: 'panel', chatId: id } });
  });
});
