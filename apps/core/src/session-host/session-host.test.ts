import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachSession, readLines, type HostConnection } from './client.ts';
import { launchSession } from './launch.ts';
import { sessionFile, type Identity } from './protocol.ts';
import { createLivenessProbe } from '../platform/process-identity.ts';
import { helperEnv, launchDetached, type DetachedSpec } from '../platform/detached-launch.ts';
import { stopTree } from '../platform/tree-stop.ts';
import { hasValue } from '../platform/os-kind.ts';
import { waitFor } from '../platform/__fixtures__/harness.ts';

const CLI = fileURLToPath(new URL('./__fixtures__/numbered-cli.mjs', import.meta.url));
const FAKE_CORE = fileURLToPath(new URL('./__fixtures__/fake-core.ts', import.meta.url));
const PLANTED = 'sk-planted-7f3c9a1e5b2d4c6f';
let root = '';
const stopLater: Identity[] = [];

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    ...extra,
  };
}

async function readAll(dir: string, from: number, session?: HostConnection): Promise<string[]> {
  const out: string[] = [];
  let offset = from;
  let exited = false;
  session?.onExit(() => {
    exited = true;
  });
  await waitFor(
    () => {
      const chunk = readLines(dir, 'stdout', offset);
      out.push(...chunk.lines);
      offset = chunk.next;
      return exited || existsSync(sessionFile(dir, 'exit')) ? true : undefined;
    },
    60_000,
    'session exit',
  );
  out.push(...readLines(dir, 'stdout', offset).lines);
  return out;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'session host ü '));
});
// Остановки параллельно и с запасом: каждая снимает таблицу процессов, и под нагрузкой всего
// набора на Windows шесть последовательных снятий не укладывались в 20 с (замер 28.10).
afterAll(async () => {
  await Promise.all(stopLater.map((id) => stopTree(id, { graceMs: 500 })));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 90_000);

describe('P89 session host — core killed mid-stream, re-attach, replay, exactly once', () => {
  it('P89 core process SIGKILLed mid-stream → new client re-attaches by host pid+start, replays from the journal offset; every line exactly once, input c1 not doubled', async () => {
    const dir = mkdtempSync(join(root, 'p89-'));
    const journal = join(dir, 'journal.ndjson');
    const core = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', FAKE_CORE, dir, journal],
      { stdio: 'ignore', env: { ...process.env, COUNT: '400', PACE_MS: '8' }, windowsHide: true },
    );
    await waitFor(
      () => {
        const lines = existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').length : 0;
        return existsSync(join(dir, 'c1.acked')) && lines > 60 ? true : undefined;
      },
      60_000,
      'fake core mid-stream',
    );
    const died = new Promise((done) => core.once('exit', done));
    core.kill('SIGKILL');
    await died;

    // Журнал убитого ядра: строки и смещение; оборванная последняя запись не в счёт.
    const records = readFileSync(journal, 'utf8')
      .split('\n')
      .flatMap((raw) => {
        try {
          return [JSON.parse(raw) as { line: string; next: number }];
        } catch {
          return [];
        }
      });
    const offset = records.at(-1)?.next ?? 0;
    const attached = await attachSession(dir);
    expect(attached.state).toBe('live');
    if (attached.state !== 'live') return;
    stopLater.push(attached.record.host, ...(attached.record.child ? [attached.record.child] : []));
    expect(attached.record.host.start).not.toBe('');
    expect(await attached.session.send('c1', 'hello-1\n')).toEqual({ dup: true });
    expect(await attached.session.send('c2', 'hello-2\n')).toEqual({ dup: false });
    attached.session.end();
    const fresh = await readAll(dir, offset, attached.session);
    const all = [...records.map((r) => r.line), ...fresh];
    const numbered = all.filter((line) => line.startsWith('line '));
    expect(numbered).toEqual(Array.from({ length: 400 }, (_, i) => `line ${i + 1}`));
    expect(all.filter((line) => line === 'echo hello-1')).toHaveLength(1);
    expect(all.filter((line) => line === 'echo hello-2')).toHaveLength(1);
    expect(JSON.parse(readFileSync(sessionFile(dir, 'exit'), 'utf8'))).toMatchObject({
      code: 0,
      stopped: false,
    });
    attached.session.close();
  }, 120_000);

  it('P89 host dead without an exit record → lost, CLI identity handed back for the tree stop', async () => {
    const dir = mkdtempSync(join(root, 'lost-'));
    const launched = await launchSession({
      dir,
      sessionId: `lost-${Date.now()}`,
      command: process.execPath,
      args: [CLI],
      cwd: dir,
      env: cliEnv({ COUNT: '100000', PACE_MS: '50' }),
    });
    if (!launched.ok) throw new Error(launched.reason);
    stopLater.push(launched.child);
    process.kill(launched.host.pid, 'SIGKILL');
    const probe = createLivenessProbe(undefined, 0);
    await waitFor(async () => ((await probe.isAlive(launched.host)) === 'dead' ? true : undefined));
    const attached = await attachSession(dir);
    expect(attached).toMatchObject({
      state: 'lost',
      reason: 'host dead, no exit record',
      child: launched.child,
    });
    const report = await stopTree(launched.child, { graceMs: 1_000 });
    expect(report.residual).toEqual([]);
  });

  it('P89 stop over the channel → CLI tree stopped, exit record says stopped, host gone', async () => {
    const dir = mkdtempSync(join(root, 'stop-'));
    const launched = await launchSession({
      dir,
      sessionId: `stop-${Date.now()}`,
      command: process.execPath,
      args: [CLI],
      cwd: dir,
      env: cliEnv({ COUNT: '100000', PACE_MS: '20' }),
    });
    if (!launched.ok) throw new Error(launched.reason);
    stopLater.push(launched.child, launched.host);
    const attached = await attachSession(dir);
    if (attached.state !== 'live') throw new Error(JSON.stringify(attached));
    expect(await attached.session.stop(1_000)).toEqual({ residual: [] });
    await waitFor(() => (existsSync(sessionFile(dir, 'exit')) ? true : undefined));
    expect(JSON.parse(readFileSync(sessionFile(dir, 'exit'), 'utf8'))).toMatchObject({
      stopped: true,
    });
    const probe = createLivenessProbe(undefined, 0);
    await waitFor(async () => ((await probe.isAlive(launched.host)) === 'dead' ? true : undefined));
    expect(await probe.isAlive(launched.child)).toBe('dead');
    expect((await attachSession(dir)).state).toBe('exited');
  });

  it('P89 a command the platform refuses → launch refused with the reason, no host left', async () => {
    const dir = mkdtempSync(join(root, 'refused-'));
    const launched = await launchSession({
      dir,
      sessionId: `refused-${Date.now()}`,
      command: 'no-such-cli-xyz',
      args: [],
      cwd: dir,
      env: cliEnv(),
    });
    expect(launched).toMatchObject({ ok: false, refused: true });
    expect(launched.ok ? '' : launched.reason).toMatch(/not found/);
  });

  it.runIf(process.platform === 'win32')(
    'P89 Windows breakaway: host started through WMI is not a child of the core',
    async () => {
      const dir = mkdtempSync(join(root, 'wmi-'));
      const launched = await launchSession({
        dir,
        sessionId: `wmi-${Date.now()}`,
        command: process.execPath,
        args: [CLI],
        cwd: dir,
        env: cliEnv({ COUNT: '5', PACE_MS: '10' }),
        breakaway: true,
      });
      if (!launched.ok) throw new Error(launched.reason);
      stopLater.push(launched.child, launched.host);
      const probe = createLivenessProbe(undefined, 0);
      const table = await probe.snapshot();
      if (!hasValue(table)) throw new Error('no table');
      const row = table.value.find((r) => r.pid === launched.host.pid);
      expect(row?.ppid).not.toBe(process.pid);
      const attached = await attachSession(dir);
      if (attached.state === 'live') attached.session.end();
      await waitFor(() => (existsSync(sessionFile(dir, 'exit')) ? true : undefined), 30_000);
      if (attached.state === 'live') attached.session.close();
    },
    60_000,
  );
});

describe('P89 session host — journal offsets', () => {
  it('P89 readLines keeps an unfinished last line for the next read; next = end of the last full line', () => {
    const dir = mkdtempSync(join(root, 'lines-'));
    writeFileSync(sessionFile(dir, 'stdout'), 'a\r\nбб\npart');
    const first = readLines(dir, 'stdout', 0);
    expect(first).toEqual({ lines: ['a', 'бб'], ends: [3, 8], next: 8 });
    appendFileSync(sessionFile(dir, 'stdout'), 'ial\n');
    expect(readLines(dir, 'stdout', first.next)).toEqual({
      lines: ['partial'],
      ends: [16],
      next: 16,
    });
    expect(readLines(dir, 'stdout', 16)).toEqual({ lines: [], ends: [], next: 16 });
    expect(readLines(join(dir, 'missing'), 'stdout', 5)).toEqual({ lines: [], ends: [], next: 5 });
  });
});

describe('P112 session host — a planted key never lands in host files or the host env', () => {
  it('P112 key in the CLI env reaches the CLI; spec.json deleted; no session file holds it; host env built without it', async () => {
    const dir = mkdtempSync(join(root, 'p112-'));
    const handed: DetachedSpec[] = [];
    const launched = await launchSession(
      {
        dir,
        sessionId: `p112-${Date.now()}`,
        command: process.execPath,
        args: [CLI],
        cwd: dir,
        env: cliEnv({ COUNT: '3', PACE_MS: '200', AGENTDECK_PLANTED_KEY: PLANTED }),
      },
      {
        launch: (spec) => {
          handed.push(spec);
          return launchDetached(spec);
        },
      },
    );
    if (!launched.ok) throw new Error(launched.reason);
    stopLater.push(launched.child, launched.host);
    // То, что реально ушло ОС при запуске хоста: ни окружение, ни argv не несут ключ.
    expect(handed).toHaveLength(1);
    expect(JSON.stringify(handed[0])).not.toContain(PLANTED);
    // Linux: окружение живого хоста читается из /proc — ключа там нет.
    if (process.platform === 'linux') {
      const environ = readFileSync(`/proc/${launched.host.pid}/environ`);
      expect(environ.includes(PLANTED)).toBe(false);
    }
    const attached = await attachSession(dir);
    if (attached.state !== 'live') throw new Error(JSON.stringify(attached));
    attached.session.end();
    const lines = await readAll(dir, 0, attached.session);
    attached.session.close();
    expect(lines[0]).toBe('key:yes');
    expect(existsSync(sessionFile(dir, 'spec'))).toBe(false);
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name)).includes(PLANTED), name).toBe(false);
    }
    expect(
      Object.values(helperEnv({ ...process.env, AGENTDECK_PLANTED_KEY: PLANTED })),
    ).not.toContain(PLANTED);
  });
});
