import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killPidTree } from '../../../lib/process-tree/process-tree.ts';
import { isPidAlive } from '../run-ledger/run-ledger.ts';
import { connectRelay } from './live-transport.ts';

/**
 * Пауза группы 23.10 (N1b): цепочка `timeout` → tests-cli → vitest жила 40
 * минут после снятия сессии. Посредник снимал дерево CLI, но посредник,
 * переживший обновление панели, исполняет код со своего старта. Теперь сервер
 * сам снимает всё под посредником одним снимком, пока дерево цело, а
 * посредника оставляет — он скажет код выхода CLI.
 *
 * Настоящие здесь канал, `connectRelay`, `killPidTree` и процессы: «посредник»
 * слушает канал и на `relay_kill` НЕ отвечает (старый код), под ним цепочка
 * ребёнок → внук.
 */

let relay: ChildProcess | undefined;
let dir: string | undefined;

afterEach(() => {
  if (relay?.pid) killPidTree(relay.pid);
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  relay = undefined;
  dir = undefined;
});

function pipeName(): string {
  const id = `agentdeck-test-${process.pid}-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

const waitFor = async (check: () => boolean, ms = 15_000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
};

describe('connectRelay: «снять» сессию с каналом', () => {
  it('потомки посредника сняты сервером, даже если посредник не слушается; сам он жив', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-relay-tree-'));
    const pipe = pipeName();
    const pidFile = (name: string): string => join(dir!, `${name}.pid`);
    const leaf = join(dir, 'leaf.cjs');
    const mid = join(dir, 'mid.cjs');
    const fakeRelay = join(dir, 'relay.cjs');
    writeFileSync(
      leaf,
      `require('fs').writeFileSync(${JSON.stringify(pidFile('leaf'))}, String(process.pid));\n` +
        'setInterval(() => {}, 1000);\n',
    );
    writeFileSync(
      mid,
      `require('child_process').spawn(process.execPath, [${JSON.stringify(leaf)}], { stdio: 'ignore', windowsHide: true });\n` +
        `require('fs').writeFileSync(${JSON.stringify(pidFile('mid'))}, String(process.pid));\n` +
        'setInterval(() => {}, 1000);\n',
    );
    writeFileSync(
      fakeRelay,
      `const net = require('net');\n` +
        `require('child_process').spawn(process.execPath, [${JSON.stringify(mid)}], { stdio: 'ignore', windowsHide: true });\n` +
        `const lines = [];\n` +
        `net.createServer((socket) => {\n` +
        `  socket.on('data', (chunk) => {\n` +
        `    lines.push(String(chunk));\n` +
        `    require('fs').writeFileSync(${JSON.stringify(join(dir, 'seen'))}, lines.join(''));\n` +
        `  });\n` +
        `  require('fs').writeFileSync(${JSON.stringify(join(dir, 'connected'))}, '1');\n` +
        `}).listen(${JSON.stringify(pipe)}, () => {\n` +
        `  require('fs').writeFileSync(${JSON.stringify(pidFile('relay'))}, String(process.pid));\n` +
        `});\n`,
    );
    relay = spawn(process.execPath, [fakeRelay], { stdio: 'ignore', windowsHide: true });
    expect(
      await waitFor(() => ['relay', 'mid', 'leaf'].every((name) => existsSync(pidFile(name)))),
    ).toBe(true);
    const below = ['mid', 'leaf'].map((name) => Number(readFileSync(pidFile(name), 'utf8')));
    expect(below.every((pid) => isPidAlive(pid))).toBe(true);

    let closed = false;
    const transport = connectRelay(
      { pipe, pid: relay.pid! },
      {
        line: () => undefined,
        stderr: () => undefined,
        close: () => {
          closed = true;
        },
      },
    );
    expect(await waitFor(() => existsSync(join(dir!, 'connected')))).toBe(true);
    // Канал поднят и у клиента: первая строка дошла до посредника.
    transport.write('{"type":"ping"}\n');
    expect(await waitFor(() => existsSync(join(dir!, 'seen')))).toBe(true);

    transport.kill();

    expect(await waitFor(() => below.every((pid) => !isPidAlive(pid)), 10_000)).toBe(true);
    expect(isPidAlive(relay.pid!)).toBe(true);
    // Просьба уйти дошла посреднику как прежде — новый посредник на неё отвечает.
    expect(
      await waitFor(() => readFileSync(join(dir!, 'seen'), 'utf8').includes('relay_kill')),
    ).toBe(true);
    expect(closed).toBe(false);
    transport.detach();
  }, 45_000);
});
