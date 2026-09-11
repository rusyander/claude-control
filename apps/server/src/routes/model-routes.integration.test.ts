import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelCatalogResponse } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import { setStoredKey } from '../lib/provider-keys.ts';
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
    const appData = join(root, 'agentdeck');
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

/**
 * Источник «контур»: список ключа вместо открытого каталога.
 *
 * Главное, что проверяется, — что панель не ходит в контур сама и что откат на
 * models.dev никогда не молчит: человек обязан узнать, почему список, которым он
 * собирался пользоваться, подменён другим.
 */
describe('маршрут каталога моделей: источник «контур»', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let appData: string;

  const get = async (url = '/api/models'): Promise<ModelCatalogResponse> =>
    (await app.inject({ method: 'GET', url })).json() as ModelCatalogResponse;

  /** Контур, у которого есть всё: он включён, с ключом и однажды ответил. */
  const connectPlatform = (): void => {
    store.updateSettings({
      modelSource: 'platform',
      modelSourcePlatform: 'enterprise-platform',
      platforms: [
        {
          id: 'enterprise-platform',
          title: 'Контур компании',
          driver: 'enterprise-platform',
          baseUrl: 'https://api.example.ru',
          enabled: true,
          mode: 'best-effort',
          budgetUsd: 0,
          capabilities: [],
          targets: [],
          projectPaths: [],
          agents: [],
          budgetSince: '',
          caCertPath: '',
        },
      ],
    });
    setStoredKey(appData, 'platform:enterprise-platform', 'sk-live');
    store.savePlatformHealth('enterprise-platform', {
      outcome: 'ok',
      reachable: true,
      url: 'https://api.example.ru/v1/models',
      detail: '',
      models: [
        { id: 'gpt-4o', kind: 'chat', ownedBy: 'openai', vision: true },
        { id: 'ru-embed', kind: 'embedding' },
      ],
      capabilities: [],
      limits: {},
      notes: [],
      compromises: [],
      checkedAt: new Date().toISOString(),
    });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-model-platform-'));
    appData = join(root, 'agentdeck');
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

  it('отдаёт список ключа и не ходит НИКУДА: ни в контур, ни на models.dev', async () => {
    connectPlatform();

    const body = await get();

    expect(body.source).toBe('platform');
    expect(body.requestedSource).toBe('platform');
    expect(body.fallback).toBeUndefined();
    expect(body.platformTitle).toBe('Контур компании');
    expect(body.models.map((m) => m.id)).toEqual(['gpt-4o', 'ru-embed']);
    // Открытие настроек согласием сходить в корпоративный контур не является.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('объявленные контуром флаги доезжают до экрана, а невыясненные — нет', async () => {
    connectPlatform();

    const chat = (await get()).models.find((m) => m.id === 'gpt-4o')!;

    expect(chat.vision).toBe(true);
    expect(chat.kind).toBe('chat');
    expect(chat.vendor).toBe('openai');
    // Функции контур не объявлял — поля нет вовсе, а не `false`.
    expect(chat.functionCalling).toBeUndefined();
    // Семейства нет ⇒ автозамена дефолта по контуру невозможна в принципе.
    expect(chat.family).toBe('');
  });

  it('выключенный контур откатывает на models.dev — и говорит, почему', async () => {
    connectPlatform();
    const platforms = store.getSettings().platforms.map((p) => ({ ...p, enabled: false }));
    store.updateSettings({ platforms });

    const body = await get();

    expect(body.source).toBe('models.dev');
    expect(body.requestedSource).toBe('platform');
    expect(body.fallback).toBe('platform-off');
    expect(body.platformTitle).toBe('Контур компании');
    expect(body.models.length).toBeGreaterThan(0);
  });

  it('контур не выбран — откат назван отдельной причиной', async () => {
    store.updateSettings({ modelSource: 'platform', modelSourcePlatform: '' });

    expect((await get()).fallback).toBe('no-platform');
  });

  it('непроверенный контур — своя причина, а не общее «не вышло»', async () => {
    connectPlatform();
    store.forgetPlatformHealth('enterprise-platform');

    expect((await get()).fallback).toBe('never-checked');
  });

  it('переключение источника туда и обратно не трогает кэш models.dev', async () => {
    // Кэш models.dev наполняется один раз; поход в контур и возврат обратно
    // обязаны обойтись без второго запроса в сеть.
    store.updateSettings({ modelSource: 'models.dev' });
    const before = await get();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);

    connectPlatform();
    expect((await get()).source).toBe('platform');

    store.updateSettings({ modelSource: 'models.dev' });
    const after = await get();

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(after.models.map((m) => m.id)).toEqual(before.models.map((m) => m.id));
    expect(after.fetchedAt).toBe(before.fetchedAt);
  });

  it('офлайн: контур не отвечает, но список и дата последнего успеха на месте', async () => {
    connectPlatform();
    const okAt = store.getPlatformHealth().enterprise-platform!.checkedAt;

    store.savePlatformHealth('enterprise-platform', {
      outcome: 'unreachable',
      reachable: false,
      url: 'https://api.example.ru/v1/models',
      detail: 'Нет связи с контуром.',
      models: [],
      capabilities: [],
      limits: {},
      notes: [],
      compromises: [],
      checkedAt: new Date().toISOString(),
    });

    const body = await get();

    expect(body.source).toBe('platform');
    expect(body.models.map((m) => m.id)).toEqual(['gpt-4o', 'ru-embed']);
    expect(body.fetchedAt).toBe(okAt);
  });

  it('нечитаемый сертификат при «обновить» — названный откат, а не отказ маршрута', async () => {
    // Проба отказом не бросается — кроме ошибки НАСТРОЙКИ: нечитаемый файл
    // корневого сертификата. Выпущенная наружу, она отвечала 400 на маршрут,
    // обязанный вернуть каталог: список пропадал с экрана целиком и молча.
    connectPlatform();
    const settings = store.getSettings();
    store.updateSettings({
      platforms: settings.platforms.map((platform) => ({
        ...platform,
        agents: [],
        caCertPath: join(root, 'нет-такого.pem'),
      })),
    });

    const response = await app.inject({ method: 'GET', url: '/api/models?refresh=true' });
    const body = response.json() as ModelCatalogResponse;

    expect(response.statusCode).toBe(200);
    expect(body.fallback).toBe('check-failed');
    expect(body.platformTitle).toBe('Контур компании');
    expect(body.source).toBe('models.dev');
  });

  it('пропавшая у контура модель остаётся в списке с пометкой', async () => {
    connectPlatform();
    store.savePlatformHealth('enterprise-platform', {
      ...store.getPlatformHealth().enterprise-platform!,
      models: [{ id: 'gpt-4o', kind: 'chat' }],
      checkedAt: new Date().toISOString(),
    });

    const gone = (await get()).models.find((m) => m.id === 'ru-embed');

    expect(gone?.retired).toBe(true);
    expect(gone?.lastSeenAt).toBeTruthy();
  });
});
