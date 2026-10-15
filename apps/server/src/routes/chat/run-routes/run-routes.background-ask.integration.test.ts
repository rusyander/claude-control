import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type BufferedEvent,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { RunLedger } from '../../../domains/chat/run-ledger/run-ledger.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Запрос прав ФОНОВОГО субагента после конца хода (живой прогон 14.10, локальная
 * Qwen, ревью MR): главный ход запустил агента в фоне и кончился, агент через
 * минуту спросил право на запись — и карточка ушла в буфер закончившегося
 * прогона, которого не видит ни одна вкладка. Брокер держал вызов (срок ≈27 ч),
 * агент стоял, модель уснула, человек видел тишину. После минуты буфера путь был
 * хуже: подхват из журнала переподключался к посреднику ЖИВОЙ сессии и закрывал
 * ей ввод — CLI уходил вместе с фоном.
 *
 * Настоящий путь: реестр → ChatRun → посредник → процесс; подменён только CLI
 * (`fake-live-cli.mjs`, режим BGASK) и сам мост прав — его POST шлём сами.
 */

const FAKE = fileURLToPath(
  new URL('../../../domains/chat/__fixtures__/fake-live-cli.mjs', import.meta.url),
);
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;
const CHAT = 'new-bgask';
/** sessionId, который печатает `fake-live-cli.mjs`. */
const SESSION = 'live-session-0001';

let root: string;
let app: FastifyInstance | undefined;
let registry: ChatRunRegistry | undefined;

afterEach(async () => {
  registry?.stopAll();
  registry?.livePool.closeAll();
  await app?.close();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* папку держит умирающий процесс */
  }
});

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function eventsOf(target: ChatRunRegistry, chatId: string): BufferedEvent['event'][] {
  const seen: BufferedEvent['event'][] = [];
  target.attach(chatId, 0, { send: (buffered) => seen.push(buffered.event), close: () => {} });
  return seen;
}

async function setup(): Promise<{ release: string; cwd: string }> {
  root = mkdtempSync(join(tmpdir(), 'cc-bgask-'));
  const appData = join(root, 'agentdeck');
  const cwd = join(root, 'work');
  mkdirSync(appData, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  registry = new ChatRunRegistry();
  registry.setLedger(new RunLedger(appData), undefined, (pid) => Promise.resolve(pid));
  const ctx = {
    store: new AppStore(appData),
    location: {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        settingsLocal: join(root, 'settings.local.json'),
        appData,
      },
    },
    backupDir: join(root, 'backups'),
    pricing: { current: () => ({ entries: [] }) },
    models: { current: () => ({ models: [] }) },
  } as unknown as ServerContext;
  app = Fastify();
  registerChatRunRoutes(app, ctx, registry, new ChatSession(registry));
  await app.ready();
  const release = join(root, 'bg-done');
  registry.start(CHAT, { prompt: `BGASK ${release}`, cwd, command: COMMAND }, {});
  await waitFor(() => !registry!.isRunning(CHAT));
  return { release, cwd };
}

function askPermission(toolUseId: string) {
  return app!.inject({
    method: 'POST',
    url: '/api/chat/permission-request',
    payload: {
      runId: CHAT,
      toolName: 'Bash',
      input: { command: 'curl -s https://example.com > out.json' },
      toolUseId,
    },
  });
}

async function proveHostedAsk(release: string): Promise<void> {
  const target = registry!;
  const pending = askPermission('tu-bg');
  // Карточка видна: у разговора идёт прогон, и в его потоке — запрос прав.
  await waitFor(() => target.isRunning(CHAT), 5_000);
  await waitFor(() =>
    eventsOf(target, CHAT).some((e) => e.kind === 'permission' && e.toolUseId === 'tu-bg'),
  );
  const decided = await app!.inject({
    method: 'POST',
    url: `/api/chat/${CHAT}/permission-decision`,
    payload: { toolUseId: 'tu-bg', behavior: 'allow' },
  });
  expect(decided.statusCode).toBeLessThan(300);
  expect((await pending).json()).toMatchObject({ behavior: 'allow' });
  // Фон кончился — CLI сам начинает ход, и его забирает тот же видимый прогон.
  writeFileSync(release, 'done');
  await waitFor(() => !target.isRunning(CHAT));
  const text = eventsOf(target, CHAT)
    .map((e) => (e.kind === 'text' ? e.text : ''))
    .join('');
  expect(text).toMatch(/woke pid \d+/);
}

describe('запрос прав фонового субагента между ходами', { timeout: 40_000 }, () => {
  it('в минуту буфера: карточка в видимом прогоне, решение доходит, пробуждение — в нём же', async () => {
    const { release } = await setup();
    await proveHostedAsk(release);
  });

  it('после буфера: живая сессия не подхватывается заново (ввод CLI цел), карточка видна', async () => {
    const { release } = await setup();
    // Минута буфера прошла: законченный прогон ушёл из реестра.
    expect(registry!.discardFinished(CHAT)).toBe(true);
    const original = registry!.livePool.waking(SESSION);
    expect(original?.alive).toBe(true);
    await proveHostedAsk(release);
    // Тот же процесс и то же подключение: подхват не завёл второе и не закрыл ввод.
    expect(registry!.livePool.waking(SESSION)).toBe(original);
    expect(original?.alive).toBe(true);
    expect(registry!.livePool.size).toBe(1);
  });

  it('чтение фонового агента после буфера: разрешено молча, прогон не заводится, отказа «перезапуск» нет', async () => {
    await setup();
    registry!.discardFinished(CHAT);
    const reply = await app!.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: CHAT, toolName: 'Read', input: { file_path: 'a.txt' }, toolUseId: 'tu-r' },
    });
    expect(reply.json()).toMatchObject({ behavior: 'allow' });
    expect(registry!.isRunning(CHAT)).toBe(false);
    expect(registry!.livePool.size).toBe(1);
  });
});
