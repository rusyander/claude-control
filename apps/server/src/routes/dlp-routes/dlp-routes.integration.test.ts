import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DlpRule } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { saveRules, type DlpProxy } from '../../domains/dlp/dlp.ts';
import { registerDlpRoutes } from './dlp-routes.ts';

/**
 * Запуск и остановка слушателя на живом Fastify. Сам прокси подменён: здесь
 * проверяется связь маршрутов с настройками, а не привязка порта.
 */
describe('dlp routes — start/stop и settings.dlp.enabled', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let proxy: {
    running: boolean;
    failWith?: string;
    enabledAtStart?: boolean;
    enabledAtStop?: boolean;
  };

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
      // Ядро читает тумблер из файла настроек: к моменту просьбы «примени» он уже записан.
      start: async () => {
        proxy.enabledAtStart = enabled();
        if (proxy.failWith) throw new Error(proxy.failWith);
        proxy.running = true;
      },
      stop: async () => {
        proxy.enabledAtStop = enabled();
        proxy.running = false;
      },
    }) satisfies DlpProxy;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-dlp-routes-'));
    const appData = join(root, 'agentdeck');
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

  const enabled = (): boolean => new AppStore(join(root, 'agentdeck')).getSettings().dlp.enabled;

  it('успешный запуск запоминается как «включено» — прокси переживёт перезапуск панели', async () => {
    expect(enabled()).toBe(false);

    const res = await app.inject({ method: 'POST', url: '/api/dlp/start' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status.running).toBe(true);
    expect(enabled()).toBe(true);
    expect(proxy.enabledAtStart).toBe(true);
  });

  it('остановка снимает флаг до просьбы к ядру', async () => {
    await app.inject({ method: 'POST', url: '/api/dlp/start' });

    const res = await app.inject({ method: 'POST', url: '/api/dlp/stop' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status.running).toBe(false);
    expect(enabled()).toBe(false);
    expect(proxy.enabledAtStop).toBe(false);
  });

  it('неудачный запуск (порт занят) — 409, флаг возвращён и ядро попрошено закрыть', async () => {
    proxy.failWith = 'listen EADDRINUSE: address already in use 127.0.0.1:5179';

    const res = await app.inject({ method: 'POST', url: '/api/dlp/start' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('dlp_start_failed');
    expect(enabled()).toBe(false);
    expect(proxy.enabledAtStop).toBe(false);
  });

  it('отказ ядра с кодом раздела доходит до ответа 409 кодом', async () => {
    const { DlpStartError } = await import('../../domains/dlp/dlp.ts');
    const fail = new DlpStartError('dlp-upstream-missing', 'нет адреса наверх');
    const failing = { ...fakeProxy(), start: async () => Promise.reject(fail) };
    const other = Fastify();
    const appData = join(root, 'agentdeck');
    registerDlpRoutes(
      other,
      { location: { paths: { root, appData } }, store } as unknown as ServerContext,
      failing,
    );
    await other.ready();
    const res = await other.inject({ method: 'POST', url: '/api/dlp/start' });
    await other.close();

    expect(res.statusCode).toBe(409);
    expect(res.json().messageCode).toBe('dlp-upstream-missing');
    expect(enabled()).toBe(false);
  });

  it('ядра нет — причина карточки и отказ 409 едут кодом с вложенной причиной (core-s10 G12)', async () => {
    const { createCoreDlpProxy } = await import('../../domains/dlp/dlp.ts');
    // Настоящий клиент ядра над пустым домом: `procs.json` нет — ядро не найдено.
    const coreHome = join(root, 'no-core');
    mkdirSync(coreHome, { recursive: true });
    const real = createCoreDlpProxy({ home: () => coreHome, settingsPort: () => 5179 });
    const other = Fastify();
    const appData = join(root, 'agentdeck');
    registerDlpRoutes(
      other,
      { location: { paths: { root, appData } }, store } as unknown as ServerContext,
      real,
    );
    await other.ready();
    const info = await other.inject({ method: 'GET', url: '/api/dlp' });
    const start = await other.inject({ method: 'POST', url: '/api/dlp/start' });
    await other.close();

    const status = info.json().status;
    expect(status.error).toMatch(/^Защиту данных держит ядро, а оно не отвечает: ядро не найдено/);
    expect(status.messageCode).toBe('dlp-core-down');
    expect(status.params.reason).toMatchObject({
      messageCode: 'dlp-core-missing',
      params: { reason: expect.stringContaining('procs.json') },
    });
    expect(start.statusCode).toBe(409);
    expect(start.json()).toMatchObject({
      error: 'dlp_start_failed',
      messageCode: 'dlp-core-down',
      params: { reason: { messageCode: 'dlp-core-missing' } },
    });
    expect(enabled()).toBe(false);
  });

  it('без включённых правил запуск отвечает 400 и ничего не запоминает', async () => {
    saveRules(join(root, 'agentdeck'), [{ ...rule, enabled: false }]);

    const res = await app.inject({ method: 'POST', url: '/api/dlp/start' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('dlp_misconfigured');
    expect(enabled()).toBe(false);
  });
});
