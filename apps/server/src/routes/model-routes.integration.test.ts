import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelCatalogResponse } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { ModelCatalogStore } from '../domains/models/model-store.ts';
import type { ServerContext } from '../context.ts';
import { registerModelRoutes } from './model-routes.ts';

/**
 * Маршрут каталога моделей глазами панели: открыли настройки — список приехал,
 * вышла новая модель — дефолт переставился сам, автообновление выключено —
 * панель не ходит в сеть и настройки не трогает.
 */
const CATALOG = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        family: 'claude-opus',
        release_date: '2026-05-28',
      },
      'claude-opus-5': {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        family: 'claude-opus',
        release_date: '2026-07-24',
      },
    },
  },
};

describe('маршрут каталога моделей', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const get = async (url = '/api/models'): Promise<ModelCatalogResponse> =>
    (await app.inject({ method: 'GET', url })).json() as ModelCatalogResponse;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-model-routes-'));
    const appData = join(root, 'claude-control');
    mkdirSync(appData, { recursive: true });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(CATALOG), { status: 200 })),
    );

    store = new AppStore(appData);
    const ctx = {
      location: { paths: { root, appData } },
      store,
      models: new ModelCatalogStore(appData),
    } as unknown as ServerContext;

    app = Fastify();
    registerModelRoutes(app, ctx);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('отдаёт каталог активного провайдера с источником и вендорами', async () => {
    const body = await get();

    expect(body.provider).toBe('claude');
    expect(body.vendors).toEqual(['anthropic']);
    expect(body.source).toBe('models.dev');
    expect(body.unsupported).toBe(false);
    expect(body.models.map((model) => model.id)).toContain('claude-opus-5');
  });

  it('провайдер без объявленного вендора получает пустой каталог, а не чужой', async () => {
    const body = await get('/api/models?provider=aider');

    expect(body).toMatchObject({ provider: 'aider', unsupported: true, source: 'none' });
    expect(body.models).toEqual([]);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('пришпиленный дефолт переезжает на новое поколение и сохраняется в настройках', async () => {
    store.updateSettings({ chatModel: 'claude-opus-4-8' });

    const body = await get();

    expect(body.promoted).toMatchObject({ from: 'claude-opus-4-8', to: 'claude-opus-5' });
    expect(store.getSettings().chatModel).toBe('claude-opus-5');

    // Второй запрос менять уже нечего — сообщение о замене не повторяется.
    expect((await get()).promoted).toBeUndefined();
  });

  it('алиас остаётся алиасом: его разворачивает сам CLI', async () => {
    store.updateSettings({ chatModel: 'opus' });

    expect((await get()).promoted).toBeUndefined();
    expect(store.getSettings().chatModel).toBe('opus');
  });

  it('при выключенном автообновлении в сеть не ходим и дефолт не трогаем', async () => {
    store.updateSettings({ autoUpdateModels: false, chatModel: 'claude-opus-4-8' });

    const body = await get();

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(body.source).toBe('none');
    expect(body.promoted).toBeUndefined();
    expect(store.getSettings().chatModel).toBe('claude-opus-4-8');
  });

  it('кнопка «обновить» ходит в сеть даже при выключенном автообновлении', async () => {
    store.updateSettings({ autoUpdateModels: false });

    const body = await get('/api/models?refresh=true');

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(body.models.length).toBeGreaterThan(0);
  });
});
