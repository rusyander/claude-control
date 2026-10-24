import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { killPidTree } from '../../lib/process-tree/process-tree.ts';
import { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  RunLedger,
  type RunLedgerEntry,
} from '../../domains/chat/run-ledger/run-ledger.ts';
import { TreePause } from '../../domains/chat/tree-pause/tree-pause.ts';
import { registerChatTreeRoutes } from './tree-routes/tree-routes.ts';

/**
 * «Остановить всё» после перезапуска панели (раунд 3, 24.10): группа между
 * ходами с фоном, чей процесс новый сервер усыновил из журнала.
 *
 * Было: усыновлённая сессия знала из журнала только ЧИСЛО фоновых задач
 * (`relay.background`), а список задач пуст до первого `background_tasks_changed`.
 * `idleWithBackground` проверял список — «фона нет», и пауза дерева проходила
 * мимо: CLI жил, конец фона будил его в стоящем дереве.
 *
 * Путь настоящий: сервер A — отдельный процесс с реестром и журналом
 * (`__fixtures__/restart-server.ts`), штатно выходит (`detachAll`), посредник и
 * CLI живут; сервер B усыновляет журнал как `runtime.ts`, маршрут паузы дерева →
 * TreePause → реестр → посредник. Подменён только CLI (`fake-live-cli.mjs`, BGASK).
 */

const DOMAIN = fileURLToPath(new URL('../../domains/chat/', import.meta.url));
const FAKE = join(DOMAIN, '__fixtures__', 'fake-live-cli.mjs');
const SERVER_A = join(DOMAIN, '__fixtures__', 'restart-server.ts');
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;
const PARENT = 'родитель';
const CHAT = 'new-r';

let root: string;
let app: FastifyInstance | undefined;
let serverA: ChildProcess | undefined;
let registry: ChatRunRegistry | undefined;

afterEach(async () => {
  registry?.stopAll();
  registry?.livePool.closeAll();
  registry = undefined;
  serverA?.kill();
  serverA = undefined;
  await app?.close();
  app = undefined;
  // Посредник, переживший тест, прожил бы полчаса простоя.
  for (const entry of new RunLedger(join(root, 'agentdeck')).read()) {
    for (const pid of [entry.relay?.pid, ...(entry.pids ?? [])]) {
      if (pid !== undefined && isPidAlive(pid)) killPidTree(pid, { spawnedAt: Date.now() });
    }
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* папку держит умирающий процесс */
  }
});

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Сервер A: ход прошёл, фон идёт, журнал знает сессию; затем штатный выход. */
async function serverAWithBackground(
  appData: string,
  cwd: string,
  release: string,
): Promise<{ entry: RunLedgerEntry; cliPid: number }> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      SERVER_A,
      appData,
      cwd,
      COMMAND,
      `BGASK ${release}`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, EARLY: '0' } },
  );
  serverA = child;
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  await waitFor(() => out.includes('\n'));
  const line = out.split('\n').find((item) => item.startsWith('IDLE ')) ?? 'IDLE {}';
  const idle = JSON.parse(line.slice(5)) as { entries: RunLedgerEntry[] };
  const entry = idle.entries.find((item) => item.key === CHAT);
  if (!entry?.relay) throw new Error(`нет записи посредника: ${line}`);
  // Строка в stdin — выход тем же путём, что `runtime.shutdown` (detachAll).
  child.stdin?.write('exit\n');
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  serverA = undefined;
  return { entry, cliPid: entry.pids?.at(-1) ?? 0 };
}

async function setup(): Promise<{ store: AppStore; cliPid: number; sessionId: string }> {
  root = mkdtempSync(join(tmpdir(), 'cc-pause-reattached-'));
  const appData = join(root, 'agentdeck');
  const copy = join(root, 'wt', 'copy-0');
  mkdirSync(appData, { recursive: true });
  mkdirSync(copy, { recursive: true });
  const { entry, cliPid } = await serverAWithBackground(appData, copy, join(root, 'bg-done'));
  // Журнал застал ожидание с фоном — то, что сервер B унаследует.
  expect(entry.relay?.background).toBe(1);
  await sleep(300);
  expect(isPidAlive(cliPid)).toBe(true);

  // Сервер B: журнал читается так же, как в `runtime.ts`.
  const runs = new ChatRunRegistry();
  registry = runs;
  const ledger = new RunLedger(appData);
  runs.setLedger(ledger);
  const { adopt } = adoptableEntries(ledger.read(), {
    isAlive: isPidAlive,
    looksLikeCli: pidLooksLikeCli,
  });
  expect(adopt.map((item) => item.key)).toEqual([CHAT]);
  for (const item of adopt) expect(runs.adopt(item)).toBe(true);
  expect(runs.isRunning(CHAT)).toBe(false);

  const store = new AppStore(appData);
  store.setChatLink(CHAT, {
    parentChatId: PARENT,
    createdAt: new Date().toISOString(),
    branch: 'feature/one',
    groupIndex: 0,
    stage: 'work',
  });
  // Пауза дерева — тем же связыванием, что в runtime.
  const tree = new TreePause({
    links: () => store.getChatLinks(),
    runs,
    store: {
      get: (key) => store.getTreePause(key),
      all: () => store.getTreePauses(),
      set: (record) => store.setTreePause(record),
      clear: (key) => store.clearTreePause(key),
    },
    idle: {
      snapshot: (chatId) => runs.idleWithBackground(chatId),
      close: (chatId) => runs.closeLive(chatId),
    },
  });
  const ctx = {
    location: { paths: { root, appData } },
    store,
    backupDir: join(appData, 'backups'),
  } as unknown as ServerContext;
  app = Fastify();
  registerChatTreeRoutes(app, ctx, tree);
  await app.ready();
  return { store, cliPid, sessionId: entry.sessionId ?? '' };
}

describe('пауза дерева после перезапуска панели', { timeout: 60_000 }, () => {
  it('«Остановить всё»: усыновлённая группа между ходами с фоном снята и записана к продолжению', async () => {
    const { store, cliPid, sessionId } = await setup();

    const res = await app!.inject({
      method: 'POST',
      url: `/api/chat/${encodeURIComponent(PARENT)}/tree/pause`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ root: PARENT, stopped: 1, unconfirmed: 0, chats: 1 });
    expect(Object.values(store.getTreePause(PARENT)?.chats ?? {})).toEqual([
      expect.objectContaining({ sessionId }),
    ]);
    await waitFor(() => !isPidAlive(cliPid));
  });

  it('сторож групп и продолжение видят фон усыновлённой сессии: число из журнала, описаний ещё нет', async () => {
    const { sessionId } = await setup();

    // Сторож (`group-watch-wiring`) считает группу идущей по этому снимку.
    expect(registry!.idleWithBackground(CHAT)).toMatchObject({ key: CHAT, sessionId });
    // Продолжение после паузы группы называет задачи, что умрут: имени нет, число есть.
    expect(registry!.backgroundTasksOf(CHAT)).toEqual([
      expect.stringMatching(/background task .*name unknown/),
    ]);
  });
});
