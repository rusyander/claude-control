import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerContext } from '../../context.ts';
import { DEV_RESTART_REQUEST, writeRestartState } from '../../lib/dev-restart.mjs';
import { registerDevRestartRoutes } from './dev-restart-routes.ts';

/** Отложенный перезапуск dev-сервера: статус для панели и запрос сторожу (решение 30.09). */
describe('/api/dev-restart', () => {
  let appData: string | undefined;
  // Под сторожем dev-сервера переменная указывает на НАСТОЯЩИЙ каталог панели: агент,
  // запустивший тесты из чата, оставил бы там запрос, и сторож перезапустил бы панель
  // посреди живых ходов (ревью PR #1). Тест ходит только во временный каталог.
  beforeEach(() => {
    vi.stubEnv('AGENTDECK_DEV_RESTART_DIR', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (appData) rmSync(appData, { recursive: true, force: true });
    appData = undefined;
  });

  async function build() {
    appData = mkdtempSync(join(tmpdir(), 'dev-restart-route-'));
    const app = Fastify();
    const ctx = { location: { paths: { appData } } } as unknown as ServerContext;
    registerDevRestartRoutes(app, ctx);
    await app.ready();
    return { app, appData };
  }

  it('правки не ждут — POST запроса не оставляет', async () => {
    const { app, appData: dir } = await build();
    expect((await app.inject({ method: 'GET', url: '/api/dev-restart' })).json()).toEqual({
      pending: false,
    });
    const posted = await app.inject({ method: 'POST', url: '/api/dev-restart' });
    expect(posted.json()).toEqual({ pending: false });
    expect(existsSync(join(dir, DEV_RESTART_REQUEST))).toBe(false);
  });

  it('правки ждут у живого сторожа — POST оставляет запрос, статус его видит', async () => {
    const { app, appData: dir } = await build();
    writeRestartState(dir, {
      pid: process.pid,
      since: '2026-09-30T10:00:00.000Z',
      files: ['apps/server/src/index.ts'],
      waitingFor: 'runs',
    });
    const before = (await app.inject({ method: 'GET', url: '/api/dev-restart' })).json();
    expect(before).toMatchObject({ pending: true, waitingFor: 'runs', requested: false });
    const posted = (await app.inject({ method: 'POST', url: '/api/dev-restart' })).json();
    expect(posted).toMatchObject({ pending: true, requested: true });
    expect(existsSync(join(dir, DEV_RESTART_REQUEST))).toBe(true);
  });
});
