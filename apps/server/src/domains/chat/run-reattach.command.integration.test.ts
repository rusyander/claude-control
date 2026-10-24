import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killPidTree } from '../../lib/process-tree/process-tree.ts';
import { AutoContinue } from './auto-continue/auto-continue.ts';
import { continueOnBackgroundLost } from './background-lost.ts';
import { ChatRunRegistry } from './ChatRunRegistry/ChatRunRegistry.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  RunLedger,
  type RunLedgerEntry,
} from './run-ledger/run-ledger.ts';

/**
 * EF-190: продолжение усыновлённого прогона поднимает ТОТ ЖЕ CLI, которым прогон
 * шёл, а не `claude` из PATH. Всё настоящее: сервер A — отдельный процесс с
 * реестром и журналом, посредник, CLI провайдера — скрипт `fakeprov` в PATH,
 * который пишет свой argv и говорит протоколом CLI (`fake-live-cli.mjs`). Рядом
 * в том же PATH лежит заглушка `claude`: позови продолжение CLI по умолчанию —
 * строка ляжет в её файл, а не в файл провайдера.
 *
 * Сервер B — этот процесс, порядок `runtime.ts`: журнал → `adoptableEntries` →
 * `adopt` (подключение к посреднику) → слушатель потерянного фона
 * `continueOnBackgroundLost` → `AutoContinue` → `start` с параметрами из журнала.
 * Подменено одно: `isLocal` — да (в панели продолжение обрыва — у локальных прогонов).
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE = join(HERE, '__fixtures__', 'fake-live-cli.mjs');
const SERVER_A = join(HERE, '__fixtures__', 'restart-server.ts');
const WINDOWS = process.platform === 'win32';

let dirs: string[] = [];
let serverA: ChildProcess | undefined;
let registry: ChatRunRegistry | undefined;
const savedPath = process.env.PATH;
const savedDump = process.env.FAKE_ARGV_DUMP;

afterEach(() => {
  registry?.stopAll();
  serverA?.kill();
  process.env.PATH = savedPath;
  if (savedDump === undefined) delete process.env.FAKE_ARGV_DUMP;
  else process.env.FAKE_ARGV_DUMP = savedDump;
  for (const dir of dirs) {
    for (const entry of new RunLedger(dir).read()) {
      const pid = entry.relay?.pid;
      if (pid !== undefined && isPidAlive(pid)) killPidTree(pid, { spawnedAt: Date.now() });
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

/** Каталог PATH: `fakeprov` — CLI провайдера, `claude` — заглушка CLI по умолчанию. */
function fakeBin(bin: string, defaultDump: string): void {
  if (WINDOWS) {
    writeFileSync(join(bin, 'fakeprov.cmd'), `@"${process.execPath}" "${FAKE}" %*\r\n`);
    writeFileSync(join(bin, 'claude.cmd'), `@echo DEFAULT %*>>"${defaultDump}"\r\n@exit /b 1\r\n`);
    return;
  }
  writeFileSync(join(bin, 'fakeprov'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "DEFAULT $*" >> "${defaultDump}"\nexit 1\n`);
  chmodSync(join(bin, 'fakeprov'), 0o755);
  chmodSync(join(bin, 'claude'), 0o755);
}

async function runServerA(
  appData: string,
  cwd: string,
  prompt: string,
): Promise<{ text: string; entries: RunLedgerEntry[] }> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', SERVER_A, appData, cwd, 'fakeprov', prompt],
    { stdio: ['ignore', 'pipe', 'inherit'], env: process.env },
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
  child.kill();
  await exited;
  serverA = undefined;
}

const lines = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];

describe('усыновлённый прогон продолжается своим CLI (EF-190)', { timeout: 90_000 }, () => {
  it('подхват после перезапуска, потерянный фон, продолжение — тот же CLI провайдера', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'reattach-cmd-data-'));
    const cwd = mkdtempSync(join(tmpdir(), 'reattach-cmd-cwd-'));
    const bin = mkdtempSync(join(tmpdir(), 'reattach-cmd-bin-'));
    dirs.push(appData, cwd, bin);
    const argvDump = join(bin, 'fakeprov-argv.jsonl');
    const defaultDump = join(bin, 'default-claude.txt');
    fakeBin(bin, defaultDump);
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
    process.env.FAKE_ARGV_DUMP = argvDump;

    // Сервер A: ход с фоном, который не кончится, — сессия ждёт в журнале.
    const first = await runServerA(appData, cwd, 'HOLDBG');
    expect(first.text).toMatch(/^turn 1 pid \d+$/);
    const entry = first.entries.find((item) => item.key === 'new-r');
    expect(entry?.idle).toBe(true);
    expect(entry?.relay?.background).toBe(1);
    expect(lines(argvDump)).toHaveLength(1);
    await killServerA();

    // Сервер B подхватывает сессию через посредника.
    registry = new ChatRunRegistry();
    const ledger = new RunLedger(appData);
    registry.setLedger(ledger);
    const target = registry;
    const autoContinue = new AutoContinue({
      start: (chatId, options, meta) => target.start(chatId, options, meta),
      isLocal: () => true,
      schedule: (run) => {
        run();
        return undefined;
      },
      log: () => undefined,
    });
    registry.setBackgroundLostListener(
      continueOnBackgroundLost({ getChatLink: () => undefined }, registry, autoContinue),
    );
    const { adopt } = adoptableEntries(ledger.read(), {
      isAlive: isPidAlive,
      looksLikeCli: pidLooksLikeCli,
    });
    expect(adopt.map((item) => item.key)).toEqual(['new-r']);
    for (const item of adopt) expect(registry.adopt(item)).toBe(true);
    expect(registry.isProcessAlive('new-r')).toBe(true);

    // Процесс уходит, держа фон: пробуждения не будет — продолжение по журналу.
    killPidTree(entry?.relay?.pid ?? -1, { spawnedAt: Date.now() });
    await waitFor(() => lines(argvDump).length >= 2 || lines(defaultDump).length > 0, 30_000);

    expect(lines(defaultDump)).toEqual([]);
    const resumed = JSON.parse(lines(argvDump)[1] ?? '[]') as string[];
    expect(resumed).toContain('--resume');
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe(entry?.sessionId);
  });
});
