import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformSchema } from '@agentdeck/contracts/platform';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { isPidAlive } from '../chat/run-ledger/run-ledger.ts';
import { buildManagedProfile } from '../platform/apply/profile.ts';
import { writePlatform, writeToken } from '../platform/store/store.ts';
import { resolveWatcherRoute } from './route.ts';
import { BackgroundWatcher } from './watcher.ts';
import type { WatchSignal } from './types.ts';

/**
 * Разбор наблюдателя идёт маршрутом, выбранным в панели, а не всегда в облако
 * Claude (задача «любой провайдер во всём приложении»).
 *
 * До правки наблюдатель запускал `claude` с дешёвой моделью вендора при любом
 * активном CLI и при любом профиле «Ассистент панели»: человек, сведший панель
 * в контур, получал разбор кода мимо контура. Настоящие здесь решение маршрута
 * (`resolveWatcherRoute` над настоящим хранилищем, контуром и ключом во
 * временной папке), наблюдатель и запуск процесса; вместо `claude` — node с
 * фальшивым CLI, который пишет свой argv и адрес модели из окружения.
 */
const FAKE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));
const SECRET = ['watch', 'contour', 'key', '3c9a'].join('-');
const CONTOUR = 'watch-contour';
const GATEWAY_PORT = 45988;

const signal500: WatchSignal = {
  source: 'server',
  kind: 'http-5xx',
  method: 'GET',
  path: '/api/chats',
  status: 500,
  message: 'Cannot read properties of undefined',
};

describe('маршрут разбора наблюдателя', () => {
  let appData: string;
  let cwd: string;
  let store: AppStore;
  let gatewayPort: number;
  const watchers: BackgroundWatcher[] = [];
  const spawned: ChildProcess[] = [];

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-watch-route-data-'));
    cwd = mkdtempSync(join(tmpdir(), 'cc-watch-route-cwd-'));
    store = new AppStore(appData);
    store.updateSettings({ provider: 'claude' });
    gatewayPort = GATEWAY_PORT;
  });
  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.shutdown();
    for (const child of spawned.splice(0)) if (child.pid && isPidAlive(child.pid)) child.kill();
    rmSync(appData, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const make = (switchEnv?: Record<string, string>): BackgroundWatcher => {
    const watcher = new BackgroundWatcher({
      appDataDir: () => appData,
      reportPath: () => join(cwd, 'WATCH-REPORT.md'),
      cwd,
      resolveCommand: () => process.execPath,
      model: () => 'haiku',
      resolveRoute: () =>
        resolveWatcherRoute({
          store,
          appDataDir: appData,
          gatewayPort: () => gatewayPort,
          ...(switchEnv ? { claudeSwitchEnv: () => switchEnv } : {}),
        }),
      language: () => (store.getSettings().language === 'en' ? 'en' : 'ru'),
      pricing: () => ({ overrides: {} }),
      spawnImpl: ((command: string, args: string[], options: object) => {
        const child = spawn(command, [FAKE, ...args], options);
        spawned.push(child);
        return child;
      }) as never,
      debounceMs: 10,
    });
    watchers.push(watcher);
    return watcher;
  };

  const dumpFile = (): string => join(cwd, 'fake-argv.json');
  const dump = (): { argv: string[]; envNames: string[]; baseUrl: string } =>
    JSON.parse(readFileSync(dumpFile(), 'utf8'));

  const contour = (): void => {
    const platform = platformSchema.parse({
      id: CONTOUR,
      title: 'Контур разбора',
      driver: 'enterprise-platform',
      baseUrl: 'https://api.dev.example.ru',
      enabled: true,
      mode: 'required',
      consumers: ['assistant'],
    });
    writePlatform(store, platform);
    writeToken(appData, CONTOUR, SECRET);
    const profile = buildManagedProfile(
      platform,
      { enabled: true, port: GATEWAY_PORT, forceStream: true },
      'qwen2.5:7b',
    );
    store.updateSettings({
      activePlatformId: CONTOUR,
      endpointProfiles: [profile],
      assistantEndpointId: profile.id,
    });
  };

  const runOnce = async (watcher: BackgroundWatcher): Promise<void> => {
    watcher.setEnabled(true);
    watcher.signal(signal500);
    await watcher.settled();
  };

  it('активен чужой CLI, маршрут в облако Claude — отказ кодом, Claude не запускается, сбой ждёт', async () => {
    store.updateSettings({ provider: 'qwen', language: 'en' });
    const watcher = make();
    await runOnce(watcher);

    expect(existsSync(dumpFile())).toBe(false);
    const status = watcher.status();
    expect(status.problem?.problemCode).toBe('route_refused');
    // Причина — на языке панели и с именем выбранного CLI.
    expect(status.problem?.detail).toContain('Qwen Code');
    expect(status.problem?.detail).toContain('leads to the Claude cloud');
    expect(status.pending).toBe(1);
    // Отказ не съел разбор из часового потолка.
    expect(status.hourlyCap.used).toBe(0);
  });

  it('профиль ассистента на контуре — разбор через шлюз контура, без --model вендора и без ключа', async () => {
    contour();
    const watcher = make();
    await runOnce(watcher);

    const { argv, envNames, baseUrl } = dump();
    expect(baseUrl).toContain(`127.0.0.1:${GATEWAY_PORT}`);
    expect(argv).not.toContain('--model');
    // Только чтение осталось: маршрут меняет адрес, а не набор инструментов.
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(readFileSync(dumpFile(), 'utf8')).not.toContain(SECRET);
    expect(envNames).toContain('ANTHROPIC_BASE_URL');
    expect(watcher.status().problem).toBeUndefined();
  });

  // Владелец 09.10.2026: «выбран Qwen на локальной модели — наблюдатель тоже идёт
  // через Qwen». До правки активный Qwen Code отказывал разбору при любом
  // маршруте, хотя контур и локальная модель уводят его туда же, куда агентов.
  it('активен Qwen Code, ассистент на контуре — разбор идёт через шлюз контура', async () => {
    store.updateSettings({ provider: 'qwen' });
    contour();
    const watcher = make();
    await runOnce(watcher);

    const { argv, baseUrl } = dump();
    expect(baseUrl).toContain(`127.0.0.1:${GATEWAY_PORT}`);
    expect(argv).not.toContain('--model');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(readFileSync(dumpFile(), 'utf8')).not.toContain(SECRET);
    expect(watcher.status().problem).toBeUndefined();
  });

  it('активен Qwen Code, Claude уведён на локальную модель — разбор идёт в неё', async () => {
    store.updateSettings({ provider: 'qwen' });
    const watcher = make({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11435',
      ANTHROPIC_MODEL: 'qwen3.6:27b-coding',
    });
    await runOnce(watcher);
    expect(dump().baseUrl).toBe('http://127.0.0.1:11435');
    expect(watcher.status().problem).toBeUndefined();
  });

  it('контур при погашенном шлюзе — отказ кодом, процесса нет', async () => {
    contour();
    gatewayPort = 0;
    const watcher = make();
    await runOnce(watcher);
    expect(existsSync(dumpFile())).toBe(false);
    expect(watcher.status().problem).toMatchObject({ problemCode: 'route_refused' });
    expect(watcher.status().problem?.detail).toContain('шлюз панели не поднят');
  });

  it('свой эндпоинт ассистента — отказ: его токен не отдаётся процессу CLI', () => {
    store.updateSettings({
      endpointProfiles: [
        {
          id: 'own',
          name: 'Своя модель',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKind: 'openai-compat',
          model: 'm',
        } as never,
      ],
      assistantEndpointId: 'own',
    });
    const route = resolveWatcherRoute({ store, appDataDir: appData, gatewayPort: () => 1 });
    expect(route).toMatchObject({
      ok: false,
      messageCode: 'watcher-endpoint-unsupported',
      params: { name: 'Своя модель' },
    });
  });

  it('Claude без профиля — прежний путь: облако вендора, дешёвая модель, адрес не подменён', async () => {
    const watcher = make();
    await runOnce(watcher);
    const { argv, baseUrl } = dump();
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(baseUrl).toBe('');
  });

  it('Claude уведён переключателем на локальную модель — разбор идёт туда же, а не в облако', async () => {
    // Наблюдатель запускается без слоя `user`, и settings.json с переключателем не
    // читает: без явного окружения разбор ушёл бы в облако («Not logged in», 08.10).
    const watcher = make({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11435',
      ANTHROPIC_MODEL: 'qwen3.6:27b-coding',
    });
    await runOnce(watcher);
    const { baseUrl, envNames } = dump();
    expect(baseUrl).toBe('http://127.0.0.1:11435');
    expect(envNames).toContain('ANTHROPIC_MODEL');
  });
});
