import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeCliExits, type CliExit } from '../../lib/cli-spawn.ts';
import { ChatRun } from './ChatRunner.ts';
import { spawnDirect } from './live-transport.ts';

/**
 * Чатовый CLI запускается своим `spawn` (разовый прогон — `ChatRun.run`, живая
 * сессия без посредника — `spawnDirect`), мимо `spawnCliProcess`, и его
 * ненулевой выход фоновый наблюдатель не видел: ошибка провайдера в чате
 * проходила мимо отчёта. Проверка — на настоящих процессах: фальшивый CLI
 * пишет в stderr и выходит с кодом.
 */

let dir: string | undefined;

afterEach(() => {
  observeCliExits(undefined);
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = undefined;
});

function fakeCli(code: number): string {
  dir = mkdtempSync(join(tmpdir(), 'chat-cli-exit-'));
  const script = join(dir, 'fake-cli.mjs');
  writeFileSync(
    script,
    `process.stdin.resume(); process.stderr.write('provider said no\\n'); setTimeout(() => process.exit(${code}), 50);\n`,
  );
  return script;
}

const quoted = (path: string) => (process.platform === 'win32' ? `"${path}"` : path);

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('ненулевой выход чатового CLI доходит до наблюдателя', () => {
  it('разовый прогон: код и хвост stderr', async () => {
    const exits: CliExit[] = [];
    observeCliExits((exit) => exits.push(exit));
    const script = fakeCli(3);

    await new ChatRun().start(
      {
        prompt: 'привет',
        cwd: dir as string,
        command: `${quoted(process.execPath)} ${quoted(script)}`,
      },
      () => undefined,
    );

    await until(() => exits.length > 0);
    expect(exits[0]?.code).toBe(3);
    expect(exits[0]?.stderr).toContain('provider said no');
  }, 20_000);

  it('разовый прогон с кодом 0 — не сбой, наблюдатель молчит', async () => {
    const exits: CliExit[] = [];
    observeCliExits((exit) => exits.push(exit));
    const script = fakeCli(0);

    await new ChatRun().start(
      {
        prompt: 'привет',
        cwd: dir as string,
        command: `${quoted(process.execPath)} ${quoted(script)}`,
      },
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(exits).toEqual([]);
  }, 20_000);

  it('живая сессия без посредника: тот же присмотр', async () => {
    const exits: CliExit[] = [];
    observeCliExits((exit) => exits.push(exit));
    const script = fakeCli(5);
    let closedWith: number | undefined;

    const transport = spawnDirect(
      {
        command: process.execPath,
        args: [script],
        cwd: dir as string,
        env: process.env,
        shell: false,
      },
      { line: () => {}, stderr: () => {}, close: (code) => (closedWith = code) },
    );

    await until(() => exits.length > 0 && closedWith !== undefined);
    expect(exits[0]).toMatchObject({ command: process.execPath, code: 5 });
    expect(exits[0]?.stderr).toContain('provider said no');
    transport.end();
  }, 20_000);
});
