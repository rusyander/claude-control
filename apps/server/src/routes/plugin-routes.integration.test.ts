import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerPluginRoutes } from './plugin-routes.ts';

/**
 * Имя маркетплейса в адресе кодируется РОВНО один раз: клиент шлёт
 * `encodeURIComponent(name)`, Fastify раскодирует параметр сам. Второе
 * раскодирование в маршруте падало на «%» пятисоткой вместо честного отказа
 * по имени — и превращало `x%2541` в другое имя, чем прислал клиент.
 */
describe('plugin-routes: имя маркетплейса с процентом', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-plugin-name-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    const ctx = {
      location: { paths: { root, appData: join(root, 'agentdeck') } },
      store: new AppStore(join(root, 'agentdeck')),
    } as unknown as ServerContext;
    app = Fastify();
    registerPluginRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('«a%b» — отказ по имени (200, ok:false), а не 500; CLI не запускается', async () => {
    // Имя с «%» не проходит проверку вида — до CLI дело не доходит ни в одной ветке.
    const answer = await app.inject({
      method: 'DELETE',
      url: `/api/plugins/marketplaces/${encodeURIComponent('a%b')}`,
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ ok: false, output: expect.stringContaining('a%b') });
  });
});
