import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  bin: string;
  apiUrl: string;
  webUrl: string;
  api(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; text: string }>;
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
const { startPanelAgentModel } = (await import(
  pathToFileURL(join(REPO, 'packages', 'stub-model', 'src', 'scenarios', 'panel-agent.mjs')).href
)) as {
  startPanelAgentModel(
    program: () => Promise<string>,
  ): Promise<{ baseUrl: string; close(): Promise<void> }>;
};

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

  // Проход s10: после `core-panel.mjs` жили сиротами хост звеньев и четыре сервера заглушки —
  // оба по замыслу переживают снятие ядра (P10, P123), а стенд ядро снимает жёстко. Процессы
  // здесь — отвязанные, с рабочей папкой в стенде (держат каталог, как держали в прогоне),
  // записанные ровно так, как их пишет ядро: `procs.json → servers[]` и `resource.created`.
  it('stop() reaps the hop host (procs.json) and stub servers (journal ref) that outlive the core', async () => {
    const api = await stand.startStand({ label: 'reap-srv', web: false, core: true });
    dirs.push(api.root);
    const hop = stranger(join(api.root, 'hop-cwd'));
    const stub = stranger(join(api.root, 'stub-cwd'));
    const procsPath = join(api.coreHome, 'procs.json');
    const procs = (
      existsSync(procsPath) ? JSON.parse(readFileSync(procsPath, 'utf8')) : { v: 1, cores: [] }
    ) as { servers?: unknown[] };
    writeFileSync(
      procsPath,
      JSON.stringify({
        ...procs,
        servers: [
          ...(procs.servers ?? []),
          { kind: 'hop-host', id: 'hop-host', pid: hop, pidStart: String(mine.get(hop)) },
        ],
      }),
    );
    const task = join(api.coreHome, 'tasks', 't-stub');
    mkdirSync(task, { recursive: true });
    const ref = `http://127.0.0.1:52697/?dialect=anthropic-messages&pid=${stub}&start=${mine.get(stub)}`;
    writeFileSync(
      join(task, 'journal.jsonl'),
      `${JSON.stringify({ kind: 'resource.created', data: { kind: 'stub-server', release: 'task-end', ref } })}\n`,
    );

    const outcome = await stopOf(api);
    expect(alive(hop, mine.get(hop)!)).toBe(false);
    expect(alive(stub, mine.get(stub)!)).toBe(false);
    expect(outcome.error).toBeUndefined();
    expect(outcome.report).toEqual({ left: [] });
    expect(existsSync(api.root)).toBe(false);
  }, 240_000);
});

/**
 * Обёртка формы npm cmd-shim: на Windows ядро разбирает только её, обёртку стенда оно отвергает
 * («нужна оболочка») — так же подменяют `check-core-launch.mjs` и `core-scenario-stand.mjs`.
 */
const CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\claude.mjs" %*',
  '',
].join('\r\n');

/**
 * Подставной `claude`: версию отвечает (без неё ядро не замеряет базу), а ход не кончает никогда —
 * хост сессии и хост замера базы живы, когда стенд снимают, как у настоящего CLI посреди хода.
 */
const HANGING_CLAUDE = [
  "if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }",
  'process.stdin.resume();',
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

/**
 * Процессы node, чья командная строка называет `root`, — независимо от записей ядра (их читает
 * проверяемый код): хост сессии получает каталог сессии в argv, CLI — свои файлы из него.
 */
function processesNaming(root: string): { pid: number; created: bigint; cmd: string }[] {
  const listed = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  const table = new Map((readProcessTable() ?? []).map((row) => [row.pid, row.created]));
  const needle = root.toLowerCase();
  return listed.stdout.split(/\r?\n/).flatMap((line) => {
    const [pid, ...rest] = line.split('\t');
    const cmd = rest.join('\t');
    const created = table.get(Number(pid));
    if (!cmd.toLowerCase().includes(needle) || created === undefined) return [];
    return [{ pid: Number(pid), created, cmd }];
  });
}

describe.runIf(IS_WIN)('stand teardown reaps every session host its own core started', () => {
  // Проход s10 (F3): хост замера базы (`…/sessions/<id>/base-probe/`) с CLI под ним пережил
  // стенд, а итог снятия был `left: []`. Здесь хосты запускает НАСТОЯЩЕЕ ядро стенда: ход агента
  // панели → вопрос ядра → сессия CLI и замер базы, оба через отвязанный хост сессии.
  it('core-started hosts (session + base probe) die on stop; a host under another home lives', async () => {
    const model = await startPanelAgentModel(async () => 'never');
    const env: Record<string, string> = {};
    let api: StandApi | undefined;
    try {
      api = await stand.startStand({
        label: 'reap-core-hosts',
        core: true,
        web: true,
        fakeCli: { claude: HANGING_CLAUDE },
        env,
        // Реестр маршрутов ядро строит при загрузке из `state.json` панели — каталог называется явно.
        seed: async (paths: { cfg: string }) => {
          env.AGENTDECK_PANEL_DATA = join(paths.cfg, 'agentdeck');
        },
        settings: {
          provider: 'claude',
          endpointProfiles: [
            {
              id: 'stub',
              name: 'Stub',
              baseUrl: model.baseUrl,
              apiKind: 'anthropic',
              model: 'stub-model',
              writeToken: false,
              imagesUrl: '',
              ownerPlatformId: '',
            },
          ],
          assistantEndpointId: 'stub',
        },
      });
      const live = api;
      dirs.push(live.root);
      writeFileSync(join(live.bin, 'claude.cmd'), CMD_SHIM);
      const token = await live.api('/endpoints/stub/token', {
        method: 'PUT',
        headers: { origin: live.webUrl },
        body: { token: 'stand-stub-key' },
      });
      expect(token.status).toBe(200);

      // Хост под ДРУГИМ домом (как хост человека): снятие стенда его не касается.
      const otherHome = mkdtempSync(join(tmpdir(), 'reap-other-'));
      dirs.push(otherHome);
      const other = await launchHost(
        join(otherHome, 'tasks', 't', 'sessions', 's'),
        join(otherHome, 'cwd'),
      );

      const run = new AbortController();
      const reply = fetch(`${live.apiUrl}/api/agent/run`, {
        method: 'POST',
        signal: run.signal,
        headers: { 'content-type': 'application/json', origin: live.webUrl },
        body: JSON.stringify({
          conversationId: 'reap-1',
          messages: [{ role: 'user', content: 'hi' }],
          context: { route: '/', title: 'reap' },
        }),
      })
        .then((r) => r.text())
        // Ход оборван здесь же (`abort`) — поток ответа рвётся, это не предмет проверки.
        .catch(() => '');
      const isHost = (cmd: string) => cmd.includes('session-host');
      const before = await until(() => {
        const found = processesNaming(live.root);
        const hosts = found.filter((p) => isHost(p.cmd));
        return hosts.length >= 2 &&
          hosts.some((p) => p.cmd.includes('base-probe')) &&
          found.length >= 4
          ? found
          : undefined;
      }, 120_000);
      for (const p of before) mine.set(p.pid, p.created);

      run.abort();
      const outcome = await stopOf(live);
      await reply;
      const survivors = before.filter((p) => alive(p.pid, p.created));
      expect(survivors.map((p) => `${p.pid} ${p.cmd.slice(0, 200)}`)).toEqual([]);
      expect(outcome.error).toBeUndefined();
      expect(outcome.report?.left).toEqual([]);
      expect(alive(other.host.pid, BigInt(other.host.start))).toBe(true);
      expect(alive(other.child.pid, BigInt(other.child.start))).toBe(true);
    } finally {
      if (api) await api.stop();
      await model.close();
    }
  }, 300_000);
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

  it('reads the hop host from procs.json and stub servers from their journal ref', () => {
    const home = mkdtempSync(join(tmpdir(), 'reap-srv-'));
    dirs.push(home);
    writeFileSync(
      join(home, 'procs.json'),
      JSON.stringify({
        v: 1,
        cores: [{ pid: 1, pidStart: '1' }],
        servers: [
          { kind: 'hop-host', id: 'hop-host', pid: 31, pidStart: '300' },
          { kind: 'hop-host', id: 'torn', pid: 32 },
        ],
      }),
    );
    const task = join(home, 'tasks', 't1');
    mkdirSync(task, { recursive: true });
    const created = (ref: unknown, kind = 'stub-server') =>
      JSON.stringify({ kind: 'resource.created', data: { kind, ref } });
    writeFileSync(
      join(task, 'journal.jsonl'),
      [
        created('http://127.0.0.1:52697/?dialect=anthropic-messages&pid=41&start=400'),
        created('http://127.0.0.1:52698/?dialect=openai-chat&pid=42'),
        created('not a url'),
        created('http://127.0.0.1:1/?pid=43&start=401', 'tmpdir'),
        '',
      ].join('\n'),
    );
    const ids = stand.coreSessionIdentities(home).map((id) => `${id.role}:${id.pid}:${id.start}`);
    // Ядро (`cores[]`) — тоже: ядро панели стенда съёмки дочерним стенду не бывает (проход 6, 03.11).
    // Запись без старта — личность не доказать.
    expect(ids.sort()).toEqual(['core:1:1', 'hop-host:31:300', 'stub-server:41:400']);
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
