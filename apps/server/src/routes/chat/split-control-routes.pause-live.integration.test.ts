import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import {
  ChatRunRegistry,
  type BufferedEvent,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { RunLedger } from '../../domains/chat/run-ledger/run-ledger.ts';
import { SplitConveyor } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import { TreePause } from '../../domains/chat/tree-pause/tree-pause.ts';
import { registerChatTreeRoutes } from './tree-routes/tree-routes.ts';
import {
  pausedGroupOf,
  registerSplitControlRoutes,
  sweepGroupCopies,
  treePausedGroupOf,
} from './split-control-routes.ts';

/**
 * Пауза группы разделения гасит всё, что группа держит (журнал групп 23.10, N1a/N1c).
 *
 * Было: «Пауза» останавливала только идущий ход. Процесс CLI, ждущий
 * следующего хода с фоновой задачей, жил дальше; конец задачи будил его, и
 * группа на паузе коммитила и заводила копию. Dev-сервер копии (`vite` на
 * :5173) переживал паузу — он не потомок CLI.
 *
 * Путь настоящий: маршрут → конвейер → реестр → ChatRun → посредник → процесс.
 * Подменён только CLI (`fake-live-cli.mjs`, режим BGASK: ход кончается, фон
 * идёт до появления файла, потом CLI сам начинает ход) и заведение копии git.
 */

const FAKE = fileURLToPath(
  new URL('../../domains/chat/__fixtures__/fake-live-cli.mjs', import.meta.url),
);
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;
const PARENT = 'родитель';
const CHAT = 'chat-0';

let root: string;
let app: FastifyInstance | undefined;
let registry: ChatRunRegistry | undefined;
const spawned: ChildProcess[] = [];

afterEach(async () => {
  registry?.stopAll();
  registry?.livePool.closeAll();
  await app?.close();
  for (const child of spawned.splice(0)) child.kill();
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function textOf(target: ChatRunRegistry, chatId: string): string {
  const seen: BufferedEvent['event'][] = [];
  target.attach(chatId, 0, { send: (buffered) => seen.push(buffered.event), close: () => {} });
  return seen.map((e) => (e.kind === 'text' ? e.text : '')).join('');
}

/** Процесс «dev-сервера», запущенный из папки: путь — в его командной строке. */
async function devServer(dir: string): Promise<number> {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'dev-server.cjs');
  const up = join(dir, 'up');
  writeFileSync(
    script,
    `require('fs').writeFileSync(${JSON.stringify(up)}, '1');\nsetInterval(() => {}, 1000);\n`,
  );
  const child = spawn(process.execPath, [script], { cwd: dir, stdio: 'ignore', windowsHide: true });
  spawned.push(child);
  await waitFor(() => existsSync(up));
  return child.pid!;
}

interface Stand {
  registry: ChatRunRegistry;
  conveyor: SplitConveyor;
  store: AppStore;
  copy: string;
  release: string;
  cliPid: number;
}

async function setup(): Promise<Stand> {
  root = mkdtempSync(join(tmpdir(), 'cc-pause-live-'));
  const appData = join(root, 'agentdeck');
  const project = join(root, 'project');
  const copy = join(root, 'wt', 'copy-0');
  const release = join(root, 'bg-done');
  mkdirSync(appData, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(copy, { recursive: true });
  const runs = new ChatRunRegistry();
  registry = runs;
  runs.setLedger(new RunLedger(appData), undefined, (pid) => Promise.resolve(pid));
  const store = new AppStore(appData);
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => store.getSplitPlan(parent),
      set: (record) => store.setSplitPlan(record),
      findByTriage: (ids) => store.findSplitPlanByTriage(ids),
      all: () => store.getSplitPlans(),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => {
        const branch = record.groups[index]?.branch ?? '';
        store.setChatLink(CHAT, {
          parentChatId: record.parentChatId,
          createdAt: new Date().toISOString(),
          branch,
          groupIndex: index,
          stage: 'work',
        });
        const started = runs.start(
          CHAT,
          { prompt: `BGASK ${release}`, cwd: copy, command: COMMAND },
          {},
        );
        return {
          index,
          title: record.groups[index]?.title ?? '',
          branch,
          chatId: CHAT,
          path: copy,
          isWorktree: true,
          started,
          prompt: 'работа',
        };
      }),
      failures: [],
    }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    parallel: () => 1,
    resume: () => 'sent',
    log: () => undefined,
  });
  // Пауза дерева и сторож пробуждений — тем же связыванием, что в runtime.
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
    afterPause: (keys) => void sweepGroupCopies(store, keys),
  });
  const pausedGroup = pausedGroupOf(store, conveyor);
  const treePausedGroup = treePausedGroupOf(store, tree);
  runs.setWakeGuard((keys) => keys.some((key) => pausedGroup(key) || treePausedGroup(key)));
  const ctx = {
    location: { paths: { root, appData } },
    store,
    backupDir: join(appData, 'backups'),
    models: { current: () => ({ models: [] }) },
  } as unknown as ServerContext;
  app = Fastify();
  registerSplitControlRoutes(app, ctx, {
    runs,
    providerChats: new ProviderChatService(),
    conveyor,
  });
  registerChatTreeRoutes(app, ctx, tree);
  await app.ready();
  await conveyor.begin({
    parentChatId: PARENT,
    projectPath: project,
    proposal: { groups: [{ title: 'Раз', branch: 'feature/one', tasks: ['первая'] }] },
    request: {},
  });
  conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
  // Первый ход кончился, фоновая задача идёт — процесс ждёт следующего хода.
  await waitFor(() => /turn 1 pid \d+/.test(textOf(runs, CHAT)));
  await waitFor(() => !runs.isRunning(CHAT));
  const cliPid = Number(/turn 1 pid (\d+)/.exec(textOf(runs, CHAT))?.[1]);
  expect(isAlive(cliPid)).toBe(true);
  expect(store.getSplitPlan(PARENT)?.groups[0]?.path).toBe(copy);
  return { registry: runs, conveyor, store, copy, release, cliPid };
}

const post = (path: string, payload: object) =>
  app!.inject({
    method: 'POST',
    url: `/api/chat/split/${encodeURIComponent(PARENT)}/${path}`,
    payload,
  });

/** Конец фоновой задачи: CLI, будь он жив, начал бы ход сам. */
async function releaseBackground(stand: Stand): Promise<void> {
  writeFileSync(stand.release, 'done');
  await pause(1_500);
}

describe('пауза группы гасит её процессы', { timeout: 60_000 }, () => {
  it('«Пауза» между ходами: CLI с фоном снят, конец фона хода не начинает, dev-сервер копии снят, соседняя папка жива', async () => {
    const stand = await setup();
    const inCopy = await devServer(join(stand.copy, 'web'));
    const beside = await devServer(`${stand.copy}-old`);

    const res = await post('pause', { index: 0 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ index: 0, stopped: 1, unconfirmed: 0 });
    await waitFor(() => !isAlive(stand.cliPid));
    await waitFor(() => !isAlive(inCopy), 20_000);
    expect(isAlive(beside)).toBe(true);
    await releaseBackground(stand);
    expect(stand.registry.isRunning(CHAT)).toBe(false);
    expect(textOf(stand.registry, CHAT)).not.toMatch(/woke pid/);
  });

  it('пауза мимо маршрута (дерево, «Стоп» человека): пробуждение отклонено, процесс снят', async () => {
    const stand = await setup();
    stand.conveyor.pause(PARENT, 0);
    expect(isAlive(stand.cliPid)).toBe(true);

    await releaseBackground(stand);

    expect(textOf(stand.registry, CHAT)).not.toMatch(/woke pid/);
    expect(stand.registry.isRunning(CHAT)).toBe(false);
    await waitFor(() => !isAlive(stand.cliPid));
  });

  it('«Убрать» группу на паузе: процесс, переживший паузу, снят — убранную сторож уже не держит', async () => {
    const stand = await setup();
    stand.conveyor.pause(PARENT, 0);
    expect(isAlive(stand.cliPid)).toBe(true);

    const res = await post('drop-group', { index: 0 });

    expect(res.statusCode).toBe(200);
    await waitFor(() => !isAlive(stand.cliPid));
    await releaseBackground(stand);
    expect(textOf(stand.registry, CHAT)).not.toMatch(/woke pid/);
  });
});

/**
 * «Остановить всё» у родителя (пауза дерева) — как пауза каждой группы (23.10):
 * раньше она снимала только идущие ходы, а группа между ходами с фоном жила,
 * её конец будил CLI в стоящем дереве, dev-сервер копии работал дальше.
 */
describe('пауза дерева гасит процессы групп', { timeout: 60_000 }, () => {
  const treePost = (path: 'pause' | 'resume') =>
    app!.inject({ method: 'POST', url: `/api/chat/${encodeURIComponent(PARENT)}/tree/${path}` });

  it('«Остановить всё» между ходами: CLI с фоном снят и записан, копия выметена, «Продолжить всё» продолжает ту же сессию', async () => {
    const stand = await setup();
    const inCopy = await devServer(join(stand.copy, 'web'));
    const beside = await devServer(`${stand.copy}-old`);

    const res = await treePost('pause');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ root: PARENT, stopped: 1, unconfirmed: 0, chats: 1 });
    expect(Object.values(stand.store.getTreePause(PARENT)?.chats ?? {})).toEqual([
      expect.objectContaining({ sessionId: 'live-session-0001', cwd: stand.copy }),
    ]);
    await waitFor(() => !isAlive(stand.cliPid));
    await waitFor(() => !isAlive(inCopy), 20_000);
    expect(isAlive(beside)).toBe(true);
    await releaseBackground(stand);
    expect(stand.registry.isRunning(CHAT)).toBe(false);
    expect(textOf(stand.registry, CHAT)).not.toMatch(/woke pid/);

    const resumed = await treePost('resume');
    expect(resumed.json()).toMatchObject({ wasPaused: true, resumed: 1 });
    // Новый процесс той же сессии сделал ход.
    await waitFor(() =>
      [...textOf(stand.registry, CHAT).matchAll(/pid (\d+)/g)].some(
        (match) => Number(match[1]) !== stand.cliPid,
      ),
    );
  });

  it('группа в стоящем дереве, чей процесс пережил паузу: пробуждение отклонено, процесс снят', async () => {
    const stand = await setup();
    // Дерево стоит, а процесс группы жив (снятие не подтвердилось или гонка).
    stand.store.setTreePause({
      root: PARENT,
      at: new Date().toISOString(),
      chats: {},
      pendingStarts: [],
    });

    await releaseBackground(stand);

    expect(textOf(stand.registry, CHAT)).not.toMatch(/woke pid/);
    await waitFor(() => !isAlive(stand.cliPid));
  });
});
