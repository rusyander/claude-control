import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { resetCliLookupCache } from '../../providers/detect/detect.ts';
import type { PlatformRunRoute } from '../../domains/platform/routing/routing.ts';
import { registerAssistantRoutes } from './assistant-routes.ts';

/**
 * Помощник формы идёт МАРШРУТОМ активного провайдера, а не всегда процессом
 * `claude` (задача «любой провайдер во всём приложении»).
 *
 * До правки `/api/assist` брал имя CLI активного провайдера и отдавал ему флаги
 * Claude (`--output-format json --tools ""` …): Qwen Code получал чужие флаги, а
 * адрес контура не доезжал вовсе. Профиль ассистента («Ассистент панели»),
 * который справка обещает формам, не читался совсем.
 *
 * Запуск подменён на границе процесса (`spawnImpl`): `cli-spawn` с его сборкой
 * окружения и выбором исполняемого файла работает настоящий. На Windows рядом
 * кладётся пустой `qwen.exe` — только чтобы поиск нашёл «настоящий» файл и не
 * ушёл в `cmd.exe` (многострочный промпт там законно отказывается); запускает его
 * подменённый `spawn`, а не система.
 */
const isWindows = process.platform === 'win32';

interface Spawned {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

let app: FastifyInstance | undefined;
let dir: string;
let appData: string;
let store: AppStore;
let savedPath: string | undefined;
let savedKeys: Record<string, string | undefined>;
let spawned: Spawned[];
let routeAsked: string[];
let route: PlatformRunRoute;
let gatewayPort: number;
let http: Server | undefined;
/** Что фальшивый CLI печатает в stdout. */
let stdout: string;

function fakeSpawn(command: string, args: string[], options: Record<string, unknown>) {
  spawned.push({
    command,
    args,
    ...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env as Record<string, string> } : {}),
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
    pid: undefined,
  });
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
}

const answer = (value: unknown): void => {
  stdout = JSON.stringify(value);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cc-assist-provider-'));
  appData = join(dir, 'agentdeck');
  store = new AppStore(appData);
  store.updateSettings({ provider: 'qwen' });
  spawned = [];
  routeAsked = [];
  route = { env: {} };
  gatewayPort = 0;
  stdout = '';
  savedPath = process.env.PATH;
  savedKeys = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  if (isWindows) {
    writeFileSync(join(dir, 'qwen.exe'), '');
    writeFileSync(join(dir, 'claude.exe'), '');
    process.env.PATH = `${dir};${savedPath ?? ''}`;
  }
  resetCliLookupCache();
  app = Fastify();
  registerAssistantRoutes(app, { store, location: { paths: { appData } } } as never, {
    runRoute: (consumer) => {
      routeAsked.push(consumer);
      return route;
    },
    gatewayPort: () => gatewayPort,
    detect: (command) => command.startsWith('qwen'),
    spawnImpl: fakeSpawn as never,
  });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (http) await new Promise((resolve) => http!.close(resolve));
  http = undefined;
  process.env.PATH = savedPath;
  for (const [name, value] of Object.entries(savedKeys)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetCliLookupCache();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ask = (message = 'назови правило lint') =>
  app!.inject({
    method: 'POST',
    url: '/api/assist',
    payload: { kind: 'rule', message, fields: { title: '' }, schema: { title: 'Title.' } },
  });

describe('POST /api/assist — маршрут активного провайдера', () => {
  it('Qwen через контур: свой CLI, свой флаг, окружение маршрута и модель контура; флагов Claude нет', async () => {
    route = {
      env: {
        OPENAI_BASE_URL: 'http://127.0.0.1:9/c/_s/foreign/qwen/v1',
        OPENAI_MODEL: 'qwen2.5:7b',
      },
      model: { model: 'qwen2.5:7b', source: 'default' } as never,
    };
    answer({ reply: 'Назвал.', fields: { title: 'lint' } });

    const response = await ask();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reply: 'Назвал.', fields: { title: 'lint' } });

    expect(routeAsked).toEqual(['foreign:qwen']);
    expect(spawned).toHaveLength(1);
    const run = spawned[0]!;
    expect(basename(run.command).toLowerCase()).toMatch(/^qwen(\.exe)?$/);
    expect(run.args[0]).toBe('-p');
    expect(run.args[1]).toContain("The user's current request: назови правило lint");
    for (const claudeFlag of ['--output-format', '--tools', '--no-session-persistence']) {
      expect(run.args).not.toContain(claudeFlag);
    }
    expect(run.env?.OPENAI_BASE_URL).toBe('http://127.0.0.1:9/c/_s/foreign/qwen/v1');
    expect(run.env?.OPENAI_MODEL).toBe('qwen2.5:7b');
    // Пустая временная папка, а не каталог сервера: CLI не подхватит правила репозитория.
    expect(run.cwd).toBeDefined();
    expect(run.cwd).not.toBe(process.cwd());
  });

  it('отказ маршрута (обязательный контур без шлюза) — код и причина, процесса нет', async () => {
    route = { env: {}, refusal: 'Контур «X» обязателен, а шлюз панели не поднят' };
    const response = await ask();
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.messageCode).toBe('assistant-route-refused');
    expect(String(body.error)).toContain('шлюз панели не поднят');
    expect(body.fields).toEqual({});
    expect(spawned).toEqual([]);
  });

  it('CLI без неинтерактивного запуска и без API (Cursor) — честный отказ, Claude не подставляется', async () => {
    store.updateSettings({ provider: 'cursor' });
    const response = await ask();
    const body = response.json() as Record<string, unknown>;
    expect(body.messageCode).toBe('assistant-provider-unsupported');
    expect(body.params).toEqual({ provider: 'Cursor' });
    expect(spawned).toEqual([]);
  });

  it('CLI не найден и ключа нет — отказ с именем CLI, без запуска', async () => {
    app = Fastify();
    registerAssistantRoutes(app, { store, location: { paths: { appData } } } as never, {
      runRoute: () => route,
      gatewayPort: () => 0,
      detect: () => false,
      spawnImpl: fakeSpawn as never,
    });
    await app.ready();
    const body = (await ask()).json() as Record<string, unknown>;
    expect(body.messageCode).toBe('assistant-provider-unavailable');
    expect(body.params).toEqual({ provider: 'Qwen Code' });
    expect(spawned).toEqual([]);
  });

  it('маршрут через контур, CLI нет, а ключ есть — отказ: ключ увёл бы запрос в облако мимо контура', async () => {
    process.env.DASHSCOPE_API_KEY = 'qa-dashscope-key-1';
    route = { env: { OPENAI_BASE_URL: 'http://127.0.0.1:9/x' } };
    app = Fastify();
    registerAssistantRoutes(app, { store, location: { paths: { appData } } } as never, {
      runRoute: () => route,
      gatewayPort: () => 0,
      detect: () => false,
      spawnImpl: fakeSpawn as never,
    });
    await app.ready();
    const body = (await ask()).json() as Record<string, unknown>;
    expect(body.messageCode).toBe('assistant-contour-cli-missing');
    expect(spawned).toEqual([]);
  });

  it('профиль «Ассистент панели» выбран — ответ по его адресу, CLI не запускается (и у Claude)', async () => {
    store.updateSettings({ provider: 'claude' });
    const bodies: string[] = [];
    http = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ reply: 'С профиля.', fields: { title: 'p' } }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as AddressInfo).port;
    store.updateSettings({
      endpointProfiles: [
        {
          id: 'own',
          name: 'Своя модель',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKind: 'openai-compat',
          model: 'local-model',
        } as never,
      ],
      assistantEndpointId: 'own',
    });

    const response = await ask('назови правило p');
    expect(response.json()).toMatchObject({ reply: 'С профиля.', fields: { title: 'p' } });
    expect(spawned).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('назови правило p');
    expect(bodies[0]).toContain('local-model');
  });

  it('профиль контура при погашенном шлюзе — отказ кодом, запрос не уходит', async () => {
    store.updateSettings({
      provider: 'claude',
      endpointProfiles: [
        {
          id: 'contour-c1',
          name: 'Контур',
          baseUrl: 'http://127.0.0.1:1/c1/_s/assistant',
          apiKind: 'anthropic',
          model: 'm',
          ownerPlatformId: 'c1',
        } as never,
      ],
      assistantEndpointId: 'contour-c1',
    });
    gatewayPort = 0;
    const body = (await ask()).json() as Record<string, unknown>;
    expect(body.messageCode).toBe('assistant-contour-gateway-down');
    expect(spawned).toEqual([]);
  });

  it('Claude без профиля — прежний путь: процесс claude с лёгким окном, маршрут чужого CLI не спрашивается', async () => {
    store.updateSettings({ provider: 'claude' });
    stdout = JSON.stringify({ result: JSON.stringify({ reply: 'ok', fields: {} }) });
    await ask();
    expect(routeAsked).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(basename(spawned[0]!.command).toLowerCase()).toMatch(/^claude/);
    expect(spawned[0]!.args).toContain('--no-session-persistence');
  });
});
