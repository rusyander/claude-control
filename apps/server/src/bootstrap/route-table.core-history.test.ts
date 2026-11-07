import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatSummary } from '@agentdeck/contracts';
import type { Runtime } from './runtime/runtime.ts';
import { coreWithTurns } from '../domains/chat/core-run/__fixtures__/core-with-turns.ts';

/**
 * Таблица маршрутов (`buildRouteTable`) отдаёт историю разговоров ядра (`runtime.coreHistory`)
 * маршрутам списка чатов: разговор не-Claude CLI транскрипта не имеет, и без неё ни `/api/chats`,
 * ни список проектов телефона (`/api/chats/projects`) его не знали (этап 11, волна 3).
 *
 * Сборка живая, как у сервера: `ServerContext` на временном домашнем каталоге, `createRuntime`,
 * та же таблица маршрутов. Подменено только ядро за HTTP (другой процесс): порт чата ядра отдаёт
 * `coreWithTurns`. Разговор qwen заводится настоящим ходом реестра прогонов.
 */

const boundary = vi.hoisted(() => ({ port: undefined as unknown }));
vi.mock('../domains/chat/core-run/core-chat-port.ts', () => ({
  createCoreChatPort: () => boundary.port,
}));

const SESSION = 'route-table-qwen';

let app: FastifyInstance | undefined;
let runtime: Runtime | undefined;
let home = '';
let work = '';
const savedEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
};

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
}

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cc-route-table-history-')));
  const config = join(home, '.claude');
  work = join(home, 'work');
  for (const dir of [config, work]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config, 'settings.json'), '{}');
  process.env.CLAUDE_CONFIG_DIR = config;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  boundary.port = coreWithTurns({
    sessionId: SESSION,
    answer: 'готов',
    turnAt: 1_793_989_152_846,
  }).port;
  // Настоящий `~/.claude` владельца тест не читает и не пишет.
  const { ServerContext } = await import('../context.ts');
  const { createRuntime } = await import('./runtime/runtime.ts');
  const { buildRouteTable } = await import('./route-table.ts');
  const ctx = new ServerContext();
  if (!realpathSync(ctx.location.paths.appData).startsWith(home)) {
    throw new Error(`refusing appData ${ctx.location.paths.appData}`);
  }
  ctx.store.updateSettings({ provider: 'qwen' });
  runtime = createRuntime(ctx, 'http://127.0.0.1:1');
  const instance = Fastify();
  const access = {
    allowedOrigins: new Set<string>(),
    requiresToken: () => false,
    expectedToken: () => '',
  };
  for (const register of buildRouteTable(runtime, access)) register(instance, ctx);
  await instance.ready();
  app = instance;

  // Разговор qwen: первый ход нового чата идёт задачей ядра, книга чата запоминает его сеанс.
  runtime.chatRuns.start('new-route-table-1', { prompt: 'Почини тест', cwd: work }, {});
  await until(() => runtime?.chatRuns.active().every((run) => run.status !== 'running') ?? true);
}, 120_000);

afterAll(async () => {
  runtime?.chatRuns.stopAll();
  runtime?.shutdown();
  await app?.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('buildRouteTable: история разговоров ядра в списках чатов', () => {
  it('разговор qwen без транскрипта — в `/api/chats`', async () => {
    const reply = await app!.inject({ url: '/api/chats' });
    expect(reply.statusCode).toBe(200);
    const ids = reply.json<ChatSummary[]>().map((chat) => chat.id);
    expect(ids).toContain(SESSION);
  });

  it('и в проектах телефона (`/api/chats/projects`) — под своим каталогом', async () => {
    const reply = await app!.inject({ url: '/api/chats/projects' });
    expect(reply.statusCode).toBe(200);
    const projects = reply.json<{ path: string; chats: { id: string }[] }[]>();
    const project = projects.find((one) => one.chats.some((chat) => chat.id === SESSION));
    expect(project?.path).toBe(work);
  });
});
