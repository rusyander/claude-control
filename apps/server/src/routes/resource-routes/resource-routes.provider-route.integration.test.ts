import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { resetCliLookupCache } from '../../providers/detect/detect.ts';
import type { PlatformRunRoute } from '../../domains/platform/routing/routing.ts';
import { registerResourceRoutes } from './resource-routes.ts';

/**
 * Помощник структуры ресурса идёт тем же маршрутом провайдера, что помощник
 * формы и чат этого CLI (задача «любой провайдер во всём приложении»).
 *
 * До правки `/api/resources/:kind/:id/assist` брал имя CLI активного провайдера
 * (`activeCliCommand`) и запускал его с флагами Claude: Qwen Code через контур
 * получал чужие флаги и не получал адреса контура, а отказ маршрута не доезжал
 * до клиента кодом. Запуск подменён на границе процесса (`spawnImpl`), всё до
 * неё — настоящее: маршрут, решение, сборка окружения, чтение и запись файлов.
 */
const isWindows = process.platform === 'win32';

interface Spawned {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

let app: FastifyInstance | undefined;
let dir: string;
let root: string;
let store: AppStore;
let savedPath: string | undefined;
let spawned: Spawned[];
let route: PlatformRunRoute;
let stdout: string;

function fakeSpawn(command: string, args: string[], options: Record<string, unknown>) {
  spawned.push({
    command,
    args,
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

const skillFile = (): string => join(root, 'skills', 'demo', 'SKILL.md');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cc-structure-provider-'));
  root = join(dir, 'config');
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(skillFile(), '---\nname: demo\ndescription: x\n---\n\nтело\n', 'utf8');
  const appData = join(root, 'agentdeck');
  store = new AppStore(appData);
  store.updateSettings({ provider: 'qwen' });
  spawned = [];
  route = { env: {} };
  stdout = '';
  savedPath = process.env.PATH;
  if (isWindows) {
    // Пустой файл только для поиска: без него `cli-spawn` ушёл бы в `cmd.exe`,
    // где многострочный промпт законно отказывается. Запускает подменённый spawn.
    writeFileSync(join(dir, 'qwen.exe'), '');
    process.env.PATH = `${dir};${savedPath ?? ''}`;
  }
  resetCliLookupCache();
  const ctx = {
    location: {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        claudeMd: join(root, 'CLAUDE.md'),
        skills: join(root, 'skills'),
        hooks: join(root, 'hooks'),
        appData,
      },
    },
    backupDir: join(appData, 'backups'),
    store,
  } as unknown as ServerContext;
  app = Fastify();
  registerResourceRoutes(app, ctx, {
    runRoute: () => route,
    gatewayPort: () => 0,
    detect: (command) => command.startsWith('qwen'),
    spawnImpl: fakeSpawn as never,
  });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env.PATH = savedPath;
  resetCliLookupCache();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const assist = () =>
  app!.inject({
    method: 'POST',
    url: '/api/resources/skill/demo/assist',
    payload: { prompt: 'добавь раздел про откат' },
  });

describe('POST /api/resources/:kind/:id/assist — маршрут активного провайдера', () => {
  it('Qwen через контур: свой CLI с окружением маршрута, без флагов Claude; файл записан', async () => {
    route = { env: { OPENAI_BASE_URL: 'http://127.0.0.1:9/c/_s/foreign/qwen/v1' } };
    const next = '---\nname: demo\ndescription: x\n---\n\nтело\n\n## Откат\n';
    stdout = JSON.stringify({ reply: 'Добавил.', files: [{ path: 'SKILL.md', content: next }] });

    const response = await assist();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reply: 'Добавил.', applied: ['SKILL.md'] });
    expect(readFileSync(skillFile(), 'utf8')).toBe(next);

    expect(spawned).toHaveLength(1);
    expect(basename(spawned[0]!.command).toLowerCase()).toMatch(/^qwen(\.exe)?$/);
    expect(spawned[0]!.args[0]).toBe('-p');
    expect(spawned[0]!.args).not.toContain('--output-format');
    expect(spawned[0]!.env?.OPENAI_BASE_URL).toBe('http://127.0.0.1:9/c/_s/foreign/qwen/v1');
  });

  it('отказ маршрута — 400 с кодом и причиной, процесса нет, файл не тронут', async () => {
    route = { env: {}, refusal: 'Контур «X» обязателен, а шлюз панели не поднят' };
    const before = readFileSync(skillFile(), 'utf8');

    const response = await assist();
    expect(response.statusCode).toBe(400);
    const body = response.json() as Record<string, unknown>;
    expect(body.messageCode).toBe('assistant-route-refused');
    expect(body.params).toEqual({ reason: 'Контур «X» обязателен, а шлюз панели не поднят' });
    expect(String(body.message)).toContain('шлюз панели не поднят');
    expect(spawned).toEqual([]);
    expect(readFileSync(skillFile(), 'utf8')).toBe(before);
  });

  it('Cursor (ни неинтерактивного запуска, ни API) — отказ кодом, Claude не подставляется', async () => {
    store.updateSettings({ provider: 'cursor' });
    const body = (await assist()).json() as Record<string, unknown>;
    expect(body.messageCode).toBe('assistant-provider-unsupported');
    expect(body.params).toEqual({ provider: 'Cursor' });
    expect(spawned).toEqual([]);
  });
});
