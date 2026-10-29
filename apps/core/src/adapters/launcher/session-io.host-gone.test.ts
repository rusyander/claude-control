import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { identityOfPid } from '../../platform/process-identity.ts';
import { stopTree } from '../../platform/tree-stop.ts';
import { sessionFile, type Identity } from '../../session-host/protocol.ts';
import { launchCli } from './launch.ts';
import { stopSession } from './session-io.ts';

/**
 * Остановка отвечает только после ухода самого хоста сессии. Хост — не в дереве CLI, но его
 * рабочая папка — каталог сессии: ответ «остановлено» при живом хосте давал EBUSY на удалении
 * каталога (живой Qwen, `qwen.fixes.live`) и отказ «live host» запуску в тот же каталог (F-100).
 */

const CLI = fileURLToPath(new URL('./__fixtures__/session-cli.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'host-gone-'));
const stopLater: Identity[] = [];
let seq = 0;

afterAll(async () => {
  for (const id of stopLater) await stopTree(id, { graceMs: 500 });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function pin(session: Record<string, string>): {
  pin: Record<string, string>;
  session: Record<string, string>;
} {
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'HOME']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter);
  return { pin: env, session };
}

async function launch(mode: string) {
  seq += 1;
  const run = await launchCli({
    dir: join(root, 'sessions', `s${seq}`),
    sessionId: `host-gone-${process.pid}-${seq}`,
    command: 'node',
    args: [CLI],
    cwd: root,
    env: pin({ MODE: mode }),
    core: {
      taskId: 't-1',
      stepId: 's-1',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'session-access-value',
    },
  });
  if (!run.ok) throw new Error(run.reason);
  stopLater.push(run.child, run.host);
  return run;
}

describe('launcher stopSession: the answer comes after the session host is gone', () => {
  it.each([
    ['tree', 'tree'],
    ['soft', 'wait'],
  ] as const)(
    '%s stop: when it resolves the host has exited and the session dir is removable at once',
    async (mode, cliMode) => {
      const run = await launch(cliMode);
      const outcome = await stopSession(run.dir, mode, 5_000);
      // Сразу, без ожидания: любой зазор здесь — то самое окно, в котором каталог занят.
      const hostAlive = alive(run.host.pid);
      let removeError = '';
      try {
        rmSync(run.dir, { recursive: true, force: true });
      } catch (error) {
        removeError = (error as Error).message;
      }
      expect(hostAlive).toBe(false);
      expect(removeError).toBe('');
      expect(outcome.residual).toEqual([]);
      expect(outcome.reason).toBeUndefined();
    },
    60_000,
  );

  it('a host that stays past the wait is named in the residual with a reason, never a clean stop', async () => {
    // Исход записан, а «хост» (живой посторонний процесс под его личностью) не уходит.
    const dir = join(root, 'sessions', 'stuck-host');
    mkdirSync(dir, { recursive: true });
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const read = await identityOfPid(sleeper.pid ?? -1);
    if (!('value' in read)) throw new Error('sleeper identity unread');
    const host = read.value;
    stopLater.push(host);
    writeFileSync(
      sessionFile(dir, 'host'),
      JSON.stringify({ v: 1, host, child: null, channel: 'none', startedAt: 1 }),
    );
    writeFileSync(
      sessionFile(dir, 'exit'),
      JSON.stringify({ v: 1, code: 0, signal: null, stopped: false, at: 1 }),
    );
    const outcome = await stopSession(dir, 'tree', 1_000, 300);
    expect(outcome).toMatchObject({ how: 'already-exited', code: 0, residual: [host] });
    expect(outcome.reason).toMatch(/session host pid \d+ still alive/);
    sleeper.kill();
  }, 30_000);
});
