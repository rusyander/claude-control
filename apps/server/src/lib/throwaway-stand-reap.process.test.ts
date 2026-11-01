import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { filetimeFromMs, killLeftovers, readProcessTable, type ProcessRow } from './kill-tree.mjs';
import { removeEntry } from './safe-io/safe-io.ts';

/**
 * Уборка одноразового стенда снимает хосты сессий его ядра (проход s9: два хоста с `claude.exe`
 * пережили стенд, один — после EBUSY при удалении каталога). Хост здесь — настоящий
 * `apps/core/src/session-host/main.ts`, запущенный отвязанным, как его запускает ядро, со своим
 * CLI, у которого рабочая папка внутри стенда: так CLI держал каталог в прогоне ленты. Снятие —
 * по записи ядра (`host.json`: pid + старт), ни по имени, ни деревом стенда.
 *
 * `STAND_SRC` — модуль стенда под проверкой (прогон на прежнем коде для «красного до»).
 * Все процессы теста снимаются по записанным номерам и только живые.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const STAND = process.env.STAND_SRC
  ? pathToFileURL(resolve(process.env.STAND_SRC)).href
  : pathToFileURL(join(REPO, 'tools', 'qa', 'throwaway-stand.mjs')).href;
const HOST_MAIN = join(REPO, 'apps', 'core', 'src', 'session-host', 'main.ts');
const IS_WIN = process.platform === 'win32';

interface Identity {
  pid: number;
  start: string;
  role: string;
}
interface StandApi {
  root: string;
  coreHome: string;
  stop(): Promise<{ left: (Identity & { why: string })[]; removeError?: string } | undefined>;
}
interface StandModule {
  startStand(options: Record<string, unknown>): Promise<StandApi>;
  coreSessionIdentities(coreHome: string): Identity[];
  createdOfStart(
    start: string,
    platform?: string,
    clock?: () => { bootId: string; btimeMs: number } | undefined,
  ): bigint | null | undefined;
  reapCoreSessions(
    coreHome: string,
    impl?: Record<string, unknown>,
  ): { ids: Identity[]; stopped: number[]; unprovable: Identity[] };
  liveCoreSessions(ids: Identity[], impl?: Record<string, unknown>): (Identity & { why: string })[];
}
const stand = (await import(STAND)) as StandModule;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Процессы теста: pid → время создания (снимаются только той же личностью). */
const mine = new Map<number, bigint>();
const dirs: string[] = [];

/** Жив ли процесс той же личностью: по снимку, а не по номеру. */
function alive(pid: number, created: bigint): boolean {
  const row = readProcessTable()?.find((r) => r.pid === pid);
  return row !== undefined && row.created === created;
}

function createdOf(pid: number): bigint {
  const row: ProcessRow | undefined = readProcessTable()?.find((r) => r.pid === pid);
  if (!row) throw new Error(`pid ${pid} not in the snapshot`);
  return row.created;
}

async function until<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error('timed out');
    await pause(100);
  }
}

/**
 * Хост сессии так, как его запускает ядро (`session-host/launch.ts`): `spec.json` + `token` в
 * каталоге сессии, процесс отвязан, рабочая папка — корень тома. Ответ — `host.json` хоста.
 */
async function launchHost(sessionDir: string, cliCwd: string) {
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(cliCwd, { recursive: true });
  const cli = join(sessionDir, '..', 'cli.mjs');
  writeFileSync(cli, 'setInterval(() => {}, 1000);\n');
  const channel = IS_WIN
    ? `\\\\.\\pipe\\stand-reap-${randomBytes(6).toString('hex')}`
    : join(mkdtempSync(join(tmpdir(), 'sr-')), 'h.sock');
  writeFileSync(join(sessionDir, 'token'), randomBytes(24).toString('hex'));
  writeFileSync(
    join(sessionDir, 'spec.json'),
    JSON.stringify({
      v: 1,
      sessionId: 's-reap',
      command: process.execPath,
      args: [cli],
      cwd: cliCwd,
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      channel,
    }),
  );
  const host: ChildProcess = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', HOST_MAIN, sessionDir],
    { cwd: parse(sessionDir).root, detached: true, stdio: 'ignore', windowsHide: true },
  );
  host.unref();
  const record = await until(() => {
    try {
      const raw = JSON.parse(readFileSync(join(sessionDir, 'host.json'), 'utf8')) as {
        host: { pid: number; start: string };
        child: { pid: number; start: string } | null;
      };
      return raw.child ? raw : undefined;
    } catch {
      return undefined;
    }
  });
  mine.set(record.host.pid, BigInt(record.host.start));
  mine.set(record.child!.pid, BigInt(record.child!.start));
  return { host: record.host, child: record.child! };
}

/** Посторонний процесс (не записан ядром) с рабочей папкой внутри стенда: держит каталог. */
function stranger(cwd: string): number {
  mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  mine.set(child.pid!, createdOf(child.pid!));
  return child.pid!;
}

afterAll(async () => {
  // Только свои и только той же личностью — по дескриптору со сверкой времени создания.
  killLeftovers(mine, { slackMs: 0 });
  await pause(500);
  for (const dir of dirs) removeEntry(dir);
});

type StopOutcome = { report?: Awaited<ReturnType<StandApi['stop']>>; error?: unknown };
const stopOf = (api: StandApi): Promise<StopOutcome> =>
  api.stop().then(
    (report) => ({ report }),
    (error: unknown) => ({ error }),
  );

describe.runIf(IS_WIN)('stand teardown stops the core session hosts (real host process)', () => {
  it('stop() reaps the host and its CLI by recorded identity, then the stand dir goes', async () => {
    const api = await stand.startStand({ label: 'reap', web: false, core: true });
    dirs.push(api.root);
    const session = join(api.coreHome, 'tasks', 't-reap', 'sessions', 's-reap');
    const { host, child } = await launchHost(session, join(api.root, 'repo-worktrees', 'w'));
    expect(alive(host.pid, BigInt(host.start))).toBe(true);
    expect(alive(child.pid, BigInt(child.start))).toBe(true);

    const outcome = await stopOf(api);
    expect(alive(host.pid, BigInt(host.start))).toBe(false);
    expect(alive(child.pid, BigInt(child.start))).toBe(false);
    expect(outcome.error).toBeUndefined();
    expect(outcome.report).toEqual({ left: [] });
    expect(existsSync(api.root)).toBe(false);
  }, 240_000);

  it('a removal that fails (a stranger holds the dir) still reaps the host and is reported, not thrown', async () => {
    const api = await stand.startStand({ label: 'reap-held', web: false, core: true });
    dirs.push(api.root);
    const session = join(api.coreHome, 'tasks', 't-held', 'sessions', 's-held');
    const { host, child } = await launchHost(session, join(api.coreHome, 'cli-cwd'));
    const holder = stranger(join(api.root, 'held'));

    const outcome = await stopOf(api);
    expect(alive(host.pid, BigInt(host.start))).toBe(false);
    expect(alive(child.pid, BigInt(child.start))).toBe(false);
    expect(outcome.error).toBeUndefined();
    expect(outcome.report?.left).toEqual([]);
    expect(outcome.report?.removeError).toMatch(/EBUSY|EPERM|ENOTEMPTY/);
    // Посторонний не записан ядром — стенд его не трогает: снятие по личности, не деревом.
    expect(alive(holder, mine.get(holder)!)).toBe(true);
  }, 240_000);
});

describe.runIf(IS_WIN)('reapCoreSessions matches pid AND start, never the pid alone', () => {
  it('a record with a wrong start leaves the live process; the exact start stops it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reap-id-'));
    dirs.push(home);
    const pid = stranger(join(home, 'cwd'));
    const created = createdOf(pid);
    const record = (start: string) => {
      const dir = join(home, 'tasks', 't', 'sessions', 's');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'host.json'),
        JSON.stringify({ v: 1, host: { pid, start }, child: null, channel: 'x', startedAt: 1 }),
      );
    };

    record(String(created + 1n));
    stand.reapCoreSessions(home);
    await pause(500);
    expect(alive(pid, created)).toBe(true);

    record(String(created));
    expect(stand.reapCoreSessions(home).stopped).toContain(pid);
    await until(() => (alive(pid, created) ? undefined : true), 10_000);
    expect(stand.liveCoreSessions([{ pid, start: String(created), role: 'host' }])).toEqual([]);
  }, 60_000);
});

describe('core session identities and the leftover report', () => {
  it('reads host.json (host + cli) and session.started lines, deduplicated', () => {
    const home = mkdtempSync(join(tmpdir(), 'reap-ids-'));
    dirs.push(home);
    const task = join(home, 'tasks', 't1');
    mkdirSync(join(task, 'sessions', 's1'), { recursive: true });
    writeFileSync(
      join(task, 'sessions', 's1', 'host.json'),
      JSON.stringify({ host: { pid: 11, start: '100' }, child: { pid: 12, start: '101' } }),
    );
    const started = (hostPid: number, cliPid: number) =>
      JSON.stringify({
        kind: 'session.started',
        data: { hostPid, hostStart: '100', cliPid, cliStart: '101' },
      });
    writeFileSync(
      join(task, 'journal.jsonl'),
      [
        started(11, 12),
        started(21, 22),
        JSON.stringify({ kind: 'task.created', data: { hostPid: 99 } }),
        '{torn',
        '',
      ].join('\n'),
    );
    const ids = stand.coreSessionIdentities(home).map((id) => `${id.role}:${id.pid}`);
    expect(ids.sort()).toEqual(['cli:12', 'cli:22', 'host:11', 'host:21']);
    expect(stand.coreSessionIdentities(join(home, 'absent'))).toEqual([]);
  });

  it('start tokens per OS: Windows exact, macOS seconds, Linux only on the same boot', () => {
    expect(stand.createdOfStart('133700000000000000', 'win32')).toBe(133700000000000000n);
    expect(stand.createdOfStart('boot:1', 'win32')).toBeUndefined();
    expect(stand.createdOfStart('1700000000:ab12', 'darwin')).toBe(
      filetimeFromMs(1_700_000_000_000),
    );
    const clock = () => ({ bootId: 'b-1', btimeMs: 1_700_000_000_000 });
    expect(stand.createdOfStart('b-1:250', 'linux', clock)).toBe(filetimeFromMs(1_700_000_002_500));
    expect(stand.createdOfStart('b-0:250', 'linux', clock)).toBeNull();
    expect(stand.createdOfStart('b-1:250', 'linux', () => undefined)).toBeUndefined();
  });

  it('what is still alive with the same identity, or unprovable, is reported, not hidden', () => {
    const table = [
      { pid: 5, ppid: 1, created: 500n },
      { pid: 6, ppid: 1, created: 999n },
      { pid: 7, ppid: 1, created: 700n },
    ];
    const impl = { platform: 'win32', readTable: () => table };
    const left = stand.liveCoreSessions(
      [
        { pid: 5, start: '500', role: 'host' },
        { pid: 6, start: '600', role: 'cli' },
        { pid: 7, start: 'garbled', role: 'cli' },
        { pid: 8, start: '800', role: 'host' },
      ],
      impl,
    );
    expect(left.map((id) => [id.pid, id.why])).toEqual([
      [5, 'жив после снятия'],
      [7, 'старт не разобрать — личность не доказать'],
    ]);
    expect(
      stand.liveCoreSessions([{ pid: 5, start: '500', role: 'host' }], {
        platform: 'win32',
        readTable: () => undefined,
      }),
    ).toEqual([{ pid: 5, start: '500', role: 'host', why: 'снимка процессов нет' }]);
  });
});
