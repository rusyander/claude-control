import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { ChatRunRegistry, type BufferedEvent } from './ChatRunRegistry.ts';
import { interruptOnBackgroundLost } from './background-lost.ts';
import { SplitConveyor } from './split-conveyor.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  RunLedger,
  type RunLedgerEntry,
} from './run-ledger.ts';

/**
 * Жизнь посредника вокруг выхода сервера (решения W3-4a, b, c) — на настоящих
 * процессах: сервер A — отдельный процесс с настоящим реестром и журналом
 * (`__fixtures__/restart-server.ts`), посредник и CLI настоящие, подменён только
 * сам CLI (`fake-live-cli.mjs`).
 *
 * a — штатный выход сервера (Ctrl+C, SIGTERM, `exit`) не гасит CLI за
 *     посредником: прежний `stopAll` при выходе убивал их каждый раз.
 * b — `taskkill /T` сторожа по зависшему серверу не достаёт посредника: его
 *     родитель — пусковой процесс, умерший сразу, а не сервер.
 * c — усыновлённая группа, чей процесс умер с фоном, — обрыв с продолжением, а
 *     не вечное «ждёт фон» и не провал.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE = join(HERE, '__fixtures__', 'fake-live-cli.mjs');
const SERVER_A = join(HERE, '__fixtures__', 'restart-server.ts');
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;
const WIN = process.platform === 'win32';

let dirs: string[] = [];
let serverA: ChildProcess | undefined;
let registry: ChatRunRegistry | undefined;

function killTree(pid: number): void {
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else process.kill(pid);
}

afterEach(() => {
  registry?.stopAll();
  registry = undefined;
  serverA?.kill();
  serverA = undefined;
  // Посредник, переживший тест, прожил бы полчаса простоя.
  for (const dir of dirs) {
    for (const entry of new RunLedger(dir).read()) {
      for (const pid of [entry.relay?.pid, ...(entry.pids ?? [])]) {
        if (pid !== undefined && isPidAlive(pid)) killTree(pid);
      }
    }
  }
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      /* папку держит умирающий процесс */
    }
  }
  dirs = [];
});

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(target: ChatRunRegistry, chatId: string): string {
  const seen: BufferedEvent['event'][] = [];
  target.attach(chatId, 0, { send: (buffered) => seen.push(buffered.event), close: () => {} });
  return seen.map((event) => (event.kind === 'text' ? event.text : '')).join('');
}

function dataDirs(): { appData: string; cwd: string } {
  const appData = mkdtempSync(join(tmpdir(), 'relay-life-data-'));
  const cwd = mkdtempSync(join(tmpdir(), 'relay-life-cwd-'));
  dirs.push(appData, cwd);
  return { appData, cwd };
}

/** Сервер A: ход прошёл, ждущая сессия в журнале со всеми номерами. */
async function runServerA(
  appData: string,
  cwd: string,
  prompt: string,
  early = false,
): Promise<{ entry: RunLedgerEntry; cliPid: number }> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', SERVER_A, appData, cwd, COMMAND, prompt],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, EARLY: early ? '1' : '0' },
    },
  );
  serverA = child;
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  await waitFor(() => out.includes('\n'));
  const line = out.split('\n').find((item) => item.startsWith('IDLE ')) ?? 'IDLE {}';
  const idle = JSON.parse(line.slice(5)) as { text: string; entries: RunLedgerEntry[] };
  const entry = idle.entries.find((item) => item.key === 'new-r');
  if (!entry?.relay) throw new Error(`нет записи посредника: ${line}`);
  // Номер CLI — последний в цепочке журнала: посредник, оболочка, CLI.
  return { entry, cliPid: entry.pids?.at(-1) ?? 0 };
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once('exit', resolve));
}

/** Сервер B: журнал читается так же, как в `runtime.ts`. */
function serverB(appData: string): ChatRunRegistry {
  const target = new ChatRunRegistry();
  registry = target;
  const ledger = new RunLedger(appData);
  target.setLedger(ledger);
  const { adopt } = adoptableEntries(ledger.read(), {
    isAlive: isPidAlive,
    looksLikeCli: pidLooksLikeCli,
  });
  expect(adopt.map((item) => item.key)).toEqual(['new-r']);
  for (const item of adopt) expect(target.adopt(item)).toBe(true);
  return target;
}

describe('посредник и выход сервера', { timeout: 60_000 }, () => {
  it('a: штатный выход сервера не гасит CLI с фоном — новый сервер получает пробуждение', async () => {
    const { appData, cwd } = dataDirs();
    const { entry, cliPid } = await runServerA(appData, cwd, 'LATEWAKE');
    expect(entry.relay?.background).toBe(1);

    // Строка в stdin — выход тем же путём, что `runtime.shutdown` по Ctrl+C/SIGTERM.
    const child = serverA as ChildProcess;
    child.stdin?.write('exit\n');
    await exited(child);
    serverA = undefined;
    await sleep(500);
    expect(isPidAlive(entry.relay?.pid ?? 0)).toBe(true);
    expect(isPidAlive(cliPid)).toBe(true);

    const target = serverB(appData);
    const sessionId = entry.sessionId ?? '';
    await waitFor(() => target.describe(sessionId)?.options.wake === true);
    await waitFor(() => !target.isRunning(sessionId));
    const key = target.describe(sessionId)?.key ?? '';
    expect(textOf(target, key)).toBe(`woke pid ${cliPid}`);
  });

  it('a: штатный выход посреди хода — ход доходит до нового сервера целиком', async () => {
    const { appData, cwd } = dataDirs();
    const { entry, cliPid } = await runServerA(appData, cwd, 'MIDTURN', true);
    expect(entry.idle).toBeUndefined();

    const child = serverA as ChildProcess;
    child.stdin?.write('exit\n');
    await exited(child);
    serverA = undefined;
    expect(isPidAlive(cliPid)).toBe(true);

    const target = serverB(appData);
    await waitFor(() => !target.isRunning('new-r'));
    expect(textOf(target, 'new-r')).toBe(`midturn pid ${cliPid}`);
  });

  it.runIf(WIN)('b: taskkill /T по серверу не достаёт посредника и CLI', async () => {
    const { appData, cwd } = dataDirs();
    const { entry, cliPid } = await runServerA(appData, cwd, 'просто ход');
    const relayPid = entry.relay?.pid ?? 0;
    expect(relayPid).toBeGreaterThan(0);
    expect(entry.pid).toBe(relayPid);

    // Ровно так сторож снимает зависший сервер (`tools/keepalive.mjs`, killTree).
    const child = serverA as ChildProcess;
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await exited(child);
    serverA = undefined;
    await sleep(500);
    expect(isPidAlive(relayPid)).toBe(true);
    expect(isPidAlive(cliPid)).toBe(true);

    // И посредник рабочий: разговор идёт дальше тем же процессом.
    const target = serverB(appData);
    const sessionId = entry.sessionId ?? '';
    target.start('new-r', { prompt: 'дальше', cwd, command: COMMAND, sessionId }, { sessionId });
    await waitFor(() => !target.isRunning('new-r'));
    expect(textOf(target, 'new-r')).toBe(`turn 2 pid ${cliPid}`);
  });

  it('c: усыновлённая группа, чей процесс умер с фоном, — прервана и продолжается', async () => {
    const { appData, cwd } = dataDirs();
    const { entry, cliPid } = await runServerA(appData, cwd, 'HOLDBG');
    expect(entry.relay?.background).toBe(1);
    const child = serverA as ChildProcess;
    child.kill();
    await exited(child);
    serverA = undefined;

    const { conveyor, resumed, group } = splitOf(cwd);
    const target = serverB(appData);
    target.setBackgroundLostListener(interruptOnBackgroundLost(linksOf(entry), conveyor));
    await sleep(500);
    expect(group()?.status).toBe('background');

    // CLI умер сам (не панель): фон погиб, пробуждения не будет.
    spawnSync(WIN ? 'taskkill' : 'kill', WIN ? ['/PID', String(cliPid), '/F'] : [String(cliPid)]);
    await waitFor(() => resumed.length > 0);
    expect(group()?.status).toBe('awaiting');
    expect(group()?.waitingFor).toBe('interrupted');
    expect(group()?.interruptResumes).toBe(1);
    expect(resumed[0]?.prompt).toContain('оборвался посреди хода');
  });

  it('c: остановка панелью — не обрыв: «Остановить всех» гасит процесс, группу не трогает', async () => {
    const { appData, cwd } = dataDirs();
    const { entry, cliPid } = await runServerA(appData, cwd, 'HOLDBG');
    const child = serverA as ChildProcess;
    child.kill();
    await exited(child);
    serverA = undefined;

    const { conveyor, resumed, group } = splitOf(cwd);
    const target = serverB(appData);
    target.setBackgroundLostListener(interruptOnBackgroundLost(linksOf(entry), conveyor));
    await sleep(500);
    target.stopAll();
    await waitFor(() => !isPidAlive(cliPid));
    await sleep(500);
    expect(resumed).toEqual([]);
    expect(group()?.status).toBe('background');
  });
});

/** Связь чата группы — под обоими ключами разговора, как её пишет панель. */
function linksOf(entry: RunLedgerEntry): { getChatLink: (key: string) => ChatLink | undefined } {
  const link: ChatLink = {
    parentChatId: 'родитель',
    createdAt: '',
    branch: 'feature/one',
    groupIndex: 0,
    stage: 'work',
  };
  const keys = new Set([entry.key, entry.sessionId ?? '']);
  return { getChatLink: (key) => (keys.has(key) ? link : undefined) };
}

/** Настоящий конвейер с группой «ждёт фон»; снаружи — только продолжение сессии. */
function splitOf(cwd: string) {
  const records = new Map<string, SplitPlanRecord>();
  const resumed: { index: number; prompt: string }[] = [];
  records.set('родитель', {
    parentChatId: 'родитель',
    projectPath: cwd,
    createdAt: '2026-09-25T00:00:00.000Z',
    order: [0],
    request: {},
    proposal: { groups: [{ title: 'Раз', branch: 'feature/one', tasks: ['т'] }] },
    groups: [
      {
        index: 0,
        title: 'Раз',
        branch: 'feature/one',
        after: [],
        status: 'background',
        waitingFor: 'background',
        chatId: 'new-r',
        path: cwd,
      },
    ],
  });
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => structuredClone(records.get(parent)),
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: () => undefined,
      all: () => Object.fromEntries(records),
    },
    launch: async () => ({ chats: [], failures: [] }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    resume: (group, prompt) => {
      resumed.push({ index: group.index, prompt });
      return 'sent';
    },
    schedule: () => 0,
    log: () => undefined,
  });
  return { conveyor, resumed, group: () => records.get('родитель')?.groups[0] };
}
