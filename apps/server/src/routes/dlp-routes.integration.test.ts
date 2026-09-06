import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DlpRule } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { saveRules, type DlpProxy } from '../domains/dlp.ts';
import { registerDlpRoutes } from './dlp-routes.ts';

/**
 * Запуск и остановка слушателя на живом Fastify. Сам прокси подменён: здесь
 * проверяется связь маршрутов с настройками, а не привязка порта.
 */
describe('dlp routes — start/stop и settings.dlp.enabled', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let proxy: { running: boolean; failWith?: string };

  const rule: DlpRule = {
    id: 'name',
    name: 'Имя',
    enabled: true,
    kind: 'terms',
    terms: ['Урманов'],
    pattern: '',
    action: 'mask',
    label: 'ИМЯ',
  };

  const fakeProxy = (): DlpProxy =>
    ({
      get running() {
        return proxy.running;
      },
      status: () => ({
        running: proxy.running,
        address: '',
        upstream: '',
        requests: 0,
        masked: 0,
        blocked: 0,
      }),
      start: async () => {
        if (proxy.failWith) throw new Error(proxy.failWith);
        proxy.running = true;
      },
      stop: async () => {
        proxy.running = false;
      },
    }) as unknown as DlpProxy;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-dlp-routes-'));
    const appData = join(root, 'claude-control');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);
    store.updateSettings({
      dlp: { ...store.getSettings().dlp, upstreamUrl: 'https://api.anthropic.com' },
    });
    saveRules(appData, [rule]);
    proxy = { running: false };

    app = Fastify();
    registerDlpRoutes(
      app,
      { location: { paths: { root, appData } }, store } as unknown as ServerContext,
      fakeProxy(),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const enabled = (): boolean =>
    new AppStore(join(root, 'claude-control')).getSettings().dlp.enabled;

  it('успешный запуск запоминается как «включено» — прокси переживёт перезапуск панели', async () => {
    expect(enabled()).toBe(false);

    const res = await app.inject({ method: 'POST', url: '/api/dlp/start' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status.running).toBe(true);
    expect(enabled()).toBe(true);
  });

  it('остановка снимает флаг', async () => {
    await app.inject({ method: 'POST', url: '/api/dlp/start' });

    const res = await app.inject({ method: 'POST', url: '/api/dlp/stop' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status.running).toBe(false);
    expect(enabled()).toBe(false);
  });

  it('неудачный запуск (порт занят) — 409 и флаг не выставлен', async () => {
    proxy.failWith = 'listen EADDRINUSE: address already in use 127.0.0.1:5179';

    const res = await app.inject({ method: 'POST', url: '/api/dlp/start' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('dlp_start_failed');
    expect(enabled()).toBe(false);
  });

  it('без включённых правил запуск отвечает 400 и ничего не запоминает', async () => {
    saveRules(join(root, 'claude-control'), [{ ...rule, enabled: false }]);

    const res = await app.inject({ method: 'POST', url: '/api/dlp/start' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('dlp_misconfigured');
    expect(enabled()).toBe(false);
  });
});
