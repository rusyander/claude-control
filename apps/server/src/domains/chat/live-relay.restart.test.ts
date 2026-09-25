import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatRunRegistry, type BufferedEvent } from './ChatRunRegistry.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  RunLedger,
  type RunLedgerEntry,
} from './run-ledger.ts';

/**
 * Перезапуск панели посреди жизни агента (журнал 29, 60, 72a) — на настоящих
 * процессах: сервер A — отдельный процесс с настоящим реестром и журналом,
 * посредник и CLI — настоящие, подменён только сам CLI (`fake-live-cli.mjs`).
 * Сервер A валится так, как его валит перезапуск на Windows: TerminateProcess,
 * без обработчиков. Сервер B — этот процесс: читает журнал, как `runtime.ts`.
 *
 * До посредника CLI держался на трубах сервера: сервер умер — CLI увидел конец
 * ввода и вышел, унеся фоновую задачу. Пробуждение агента по её концу не
 * приходило никогда.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE = join(HERE, '__fixtures__', 'fake-live-cli.mjs');
const SERVER_A = join(HERE, '__fixtures__', 'restart-server.ts');
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;

let dirs: string[] = [];
let serverA: ChildProcess | undefined;
let registry: ChatRunRegistry | undefined;

afterEach(() => {
  registry?.stopAll();
  serverA?.kill();
  // Упавший тест не подхватил посредника — он прожил бы полчаса простоя.
  for (const dir of dirs) {
    for (const entry of new RunLedger(dir).read()) {
      const pid = entry.relay?.pid;
      if (pid === undefined || !isPidAlive(pid)) continue;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(pid);
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

function textOf(target: ChatRunRegistry, chatId: string): string {
  const seen: BufferedEvent['event'][] = [];
  target.attach(chatId, 0, { send: (buffered) => seen.push(buffered.event), close: () => {} });
  return seen.map((event) => (event.kind === 'text' ? event.text : '')).join('');
}

/** Поднять сервер A, дождаться конца хода и ждущей записи в журнале. */
async function runServerA(
  appData: string,
  cwd: string,
  prompt: string,
): Promise<{ text: string; entries: RunLedgerEntry[] }> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', SERVER_A, appData, cwd, COMMAND, prompt],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  serverA = child;
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  await waitFor(() => out.includes('\n'));
  const line = out.split('\n').find((item) => item.startsWith('IDLE ')) ?? 'IDLE {}';
  return JSON.parse(line.slice(5)) as { text: string; entries: RunLedgerEntry[] };
}

async function killServerA(): Promise<void> {
  const child = serverA;
  if (!child) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // На Windows — TerminateProcess: ни `stopAll`, ни конца ввода от сервера.
  child.kill();
  await exited;
  serverA = undefined;
}

describe('перезапуск панели при живой сессии', { timeout: 60_000 }, () => {
  it('CLI с фоном переживает смерть сервера, и новый сервер получает пробуждение', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'relay-restart-data-'));
    const cwd = mkdtempSync(join(tmpdir(), 'relay-restart-cwd-'));
    dirs.push(appData, cwd);

    const first = await runServerA(appData, cwd, 'LATEWAKE');
    const cliPid = /pid (\d+)/.exec(first.text)?.[1];
    expect(first.text).toMatch(/^turn 1 pid \d+$/);
    const entry = first.entries.find((item) => item.key === 'new-r');
    // Журнал 29/84: ждущая сессия в журнале, номер записи — посредник, все
    // звена цепочки перечислены, фон виден (журнал 64).
    expect(entry?.idle).toBe(true);
    expect(entry?.relay?.pipe).toBeTruthy();
    expect(entry?.pid).toBe(entry?.relay?.pid);
    expect(entry?.pids).toContain(Number(cliPid));
    expect(entry?.relay?.background).toBe(1);

    await killServerA();
    expect(isPidAlive(Number(cliPid))).toBe(true);

    // Сервер B: тот же порядок, что в `runtime.ts`.
    registry = new ChatRunRegistry();
    const ledger = new RunLedger(appData);
    registry.setLedger(ledger);
    const { adopt } = adoptableEntries(ledger.read(), {
      isAlive: isPidAlive,
      looksLikeCli: pidLooksLikeCli,
    });
    expect(adopt.map((item) => item.key)).toEqual(['new-r']);
    for (const item of adopt) expect(registry.adopt(item)).toBe(true);
    expect(registry.isProcessAlive('new-r')).toBe(true);

    // Фон кончился уже при сервере B: CLI начал ход сам, реестр завёл прогон.
    const sessionId = entry?.sessionId ?? '';
    await waitFor(() => registry?.describe(sessionId)?.options.wake === true);
    await waitFor(() => !registry?.isRunning(sessionId));
    const key = registry.describe(sessionId)?.key ?? '';
    expect(textOf(registry, key)).toBe(`woke pid ${cliPid}`);

    // И дальше разговор идёт тем же процессом.
    registry.start(key, { prompt: 'дальше', cwd, command: COMMAND, sessionId }, { sessionId });
    await waitFor(() => !registry?.isRunning(key));
    expect(textOf(registry, key)).toBe(`turn 3 pid ${cliPid}`);
  });
});
