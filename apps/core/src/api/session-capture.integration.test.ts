import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { SpoolRecord } from '@agentdeck/contracts/core/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureRoadsDetail } from '../bootstrap/session-road/capture-roads.ts';
import { installCaptureWrappers, WRAPPER_DIR } from '../bootstrap/session-road/hook-file.ts';
import { composeCaptureNodeOptions } from '../mcp/capture-wrap.ts';
import { CAPTURE_VARS } from '../platform/capture-shim.ts';
import { writeExecutable } from '../platform/exec-bit.ts';
import { currentOs } from '../platform/os-kind.ts';
import { osProcessTable, type ProcessRow } from '../platform/process-table.ts';
import { PSEUDO_FILE, PSEUDO_LOG, PSEUDO_PREFIX } from '../policy/session-tokens/pseudo-tasks.ts';
import { ingestSpool, SPOOL_RECORD, type SpoolSink } from '../verifier/spool/ingest.ts';
import {
  recordingEntry,
  startCaptureStand,
  type CaptureStand,
} from './__fixtures__/capture-stand.ts';

/**
 * Захват проверок живьём (03 §Process capture, P05, P91, P99): настоящая прокладка
 * `capture-preload.cjs` в настоящем node (`NODE_OPTIONS --require`), настоящие обёртки PATH
 * сессии (sh Git Bash и `cmd` на Windows), настоящая ручка `/v1/session/capture` на API ядра,
 * настоящие токены и очередь `spool/`. Подменены: бегун проверки (поддельный `vitest.mjs` и
 * `go`, считают свои запуски — граница «внешний инструмент») и вход проверок зоны C (волна 2:
 * записывающий вход стенда, `__fixtures__/capture-stand.ts`).
 */

const os = currentOs();
const root = mkdtempSync(join(tmpdir(), 'capture road '));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const RUNNER_JS = [
  "import { appendFileSync } from 'node:fs';",
  'const args = process.argv.slice(2);',
  "appendFileSync(process.env.FAKE_COUNTER, 'x');",
  "const failed = args.includes('--fail');",
  "console.log(`fake vitest ${args.join(' ')}: ${failed ? '1 failed' : '3 passed'}`);",
  'process.exit(failed ? 1 : 0);',
  '',
].join('\n');

const GO_JS = [
  '#!/usr/bin/env node',
  "import { appendFileSync } from 'node:fs';",
  'const args = process.argv.slice(2);',
  "appendFileSync(process.env.FAKE_COUNTER, 'g');",
  "console.log(`fake go ${args.join(' ')}`);",
  "process.exit(args.includes('fail') ? 3 : 0);",
  '',
].join('\n');

/** Проект с поддельным бегуном там, где его ищет прокладка: `node_modules/vitest/vitest.mjs`. */
function fakeProject(dir: string): string {
  const runner = join(dir, 'node_modules', 'vitest', 'vitest.mjs');
  mkdirSync(dirname(runner), { recursive: true });
  writeFileSync(runner, RUNNER_JS);
  return runner;
}

/** Поддельный `go`: POSIX — шебанг-скрипт 0755; Windows — npm-обёртка `.cmd` над `.mjs`. */
function fakeGo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (os !== 'win32') {
    const written = writeExecutable(join(dir, 'go'), GO_JS, os);
    if (!written.ok) throw new Error(written.reason);
    return;
  }
  writeFileSync(join(dir, 'go.mjs'), GO_JS);
  writeFileSync(
    join(dir, 'go.cmd'),
    [
      '@SETLOCAL',
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\go.mjs" %*',
      ') ELSE (',
      '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
      '  node  "%~dp0\\go.mjs" %*',
      ')',
    ].join('\r\n'),
  );
}

function posixShell(): string | undefined {
  if (os !== 'win32') return '/bin/sh';
  const candidates = [
    process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ];
  return candidates.find((file): file is string => Boolean(file) && existsSync(file as string));
}

/** Окружение теста без чужого захвата: ни NODE_OPTIONS, ни переменных ядра снаружи. */
function baseEnv(counter: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_COUNTER: counter };
  delete env['NODE_OPTIONS'];
  delete env['CI'];
  for (const name of Object.values(CAPTURE_VARS)) delete env[name];
  return env;
}

function sessionEnv(stand: CaptureStand, counter: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(counter),
    NODE_OPTIONS: composeCaptureNodeOptions(undefined),
    [CAPTURE_VARS.url]: stand.url,
    [CAPTURE_VARS.access]: stand.sessionToken,
    [CAPTURE_VARS.procs]: stand.layout.procs,
  };
}

const runs = (counter: string): number => (existsSync(counter) ? readFileSync(counter).length : 0);

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Запуск ребёнка БЕЗ блокировки: ручка ядра живёт в этом же процессе, и `spawnSync` остановил бы
 * её цикл событий — прокладка ждала бы ответа, который некому дать.
 */
function exec(
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env: opts.env, cwd: opts.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const runNode = (
  runner: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<Ran> => exec(process.execPath, [runner, ...args], { env, cwd });

const spoolFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : [];

function collectingSink(): SpoolSink & { records: SpoolRecord[] } {
  const records: SpoolRecord[] = [];
  return {
    records,
    async take(record) {
      records.push(record);
      return { taken: `rec-${records.length}` };
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function post(
  stand: CaptureStand,
  path: string,
  body: unknown,
  bearer?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${stand.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const DIGEST = 'a'.repeat(64);
const ask = (pid: number, extra: Record<string, unknown> = {}) => ({
  road: 'node-preload',
  argv: ['node', 'x/node_modules/vitest/vitest.mjs', 'run'],
  cwd: root,
  envDigest: DIGEST,
  env: { CI: null, NODE_ENV: null, TZ: null },
  pid,
  pidStart: 1,
  ...extra,
});

describe('session road node-preload: the check asks the core before it runs (P05, P99)', () => {
  const project = join(root, 'proj preload');
  const runner = fakeProject(project);
  const counter = join(root, 'preload.count');
  let stand: CaptureStand;
  const entry = recordingEntry(join(root, 'records-preload'));
  mkdirSync(join(root, 'records-preload'), { recursive: true });
  beforeAll(async () => {
    stand = await startCaptureStand({ entry });
  });
  afterAll(() => stand.close());

  it('first run of a key runs under a lease and reports; the same key again is replayed with the same stdout and exit, runner not started', async () => {
    const env = sessionEnv(stand, counter);
    const first = await runNode(runner, ['run', '--fail'], env, project);
    expect(first.status, first.stderr).toBe(1);
    expect(first.stdout).toContain('fake vitest run --fail: 1 failed');
    expect(runs(counter)).toBe(1);

    const second = await runNode(runner, ['run', '--fail'], env, project);
    expect(second.status, second.stderr).toBe(1);
    expect(second.stdout).toBe(first.stdout);
    expect(second.stderr).toMatch(/agentdeck: replayed /);
    expect(runs(counter)).toBe(1);

    const changedEnv = await runNode(runner, ['run', '--fail'], { ...env, CI: '1' }, project);
    expect(changedEnv.status).toBe(1);
    expect(runs(counter)).toBe(2);

    expect(entry.asks).toHaveLength(3);
    expect(entry.asks[0]).toMatchObject({
      road: 'capture-preload',
      origin: 'session',
      taskId: stand.task.taskId,
      sessionId: stand.session.sessionId,
      stepId: stand.session.stepId,
      cwd: project,
    });
    expect(entry.asks[0]!.argv.slice(1)).toEqual([runner, 'run', '--fail']);
    expect(entry.asks[2]!.envDigest).not.toBe(entry.asks[0]!.envDigest);
    // Значения имён прокладки доходят до входа: ключ прогона вызывающего — от его окружения.
    expect(entry.asks[0]!.env['CI']).toBeNull();
    expect(entry.asks[2]!.env['CI']).toBe('1');
    expect(entry.results).toHaveLength(2);
    expect(entry.results[0]).toMatchObject({
      owner: { origin: 'session', taskId: stand.task.taskId },
      result: { exit: 1 },
    });
    expect(entry.results[0]!.result.log).toContain('1 failed');
  });

  it('a process that is not a check runner is not asked about (node -e passes untouched)', async () => {
    const before = entry.asks.length;
    const plain = await exec(process.execPath, ['-e', 'console.log("plain")'], {
      env: sessionEnv(stand, counter),
      cwd: project,
    });
    expect(plain.status).toBe(0);
    expect(plain.stdout.trim()).toBe('plain');
    expect(entry.asks).toHaveLength(before);
  });

  it('uncaptured road named in the journal detail really runs uncaptured: NODE_OPTIONS reset → runner runs twice, core never asked', async () => {
    expect(captureRoadsDetail({ tools: [], failed: [] })).toContain(
      'not captured: a command that resets or replaces NODE_OPTIONS',
    );
    const before = entry.asks.length;
    const runsBefore = runs(counter);
    const env = { ...sessionEnv(stand, counter), NODE_OPTIONS: '' };
    expect((await runNode(runner, ['run', 'reset'], env, project)).status).toBe(0);
    expect((await runNode(runner, ['run', 'reset'], env, project)).status).toBe(0);
    expect(runs(counter)).toBe(runsBefore + 2);
    expect(entry.asks).toHaveLength(before);
  });
});

describe('session road path-wrapper: go behind the session PATH wrapper (P05, P99)', () => {
  const fake = join(root, 'go dir');
  fakeGo(fake);
  const sessionDir = join(root, 'session go');
  mkdirSync(join(sessionDir, WRAPPER_DIR), { recursive: true });
  const installed = installCaptureWrappers({
    dir: sessionDir,
    env: { PATH: fake },
    os,
    nodeArgv: [process.execPath],
  });
  const bin = join(sessionDir, WRAPPER_DIR);
  const counter = join(root, 'go.count');
  const entry = recordingEntry(join(root, 'records-go'));
  mkdirSync(join(root, 'records-go'), { recursive: true });
  let stand: CaptureStand;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    stand = await startCaptureStand({ entry });
    const sessionPath = [bin, fake, dirname(process.execPath), process.env['PATH'] ?? ''].join(
      delimiter,
    );
    env = { ...sessionEnv(stand, counter), PATH: sessionPath, Path: sessionPath };
  });
  afterAll(() => stand.close());

  it('only the tool found on the session PATH gets a capture wrapper', () => {
    expect(installed).toEqual({ tools: ['go'], failed: [] });
  });

  const shell = posixShell();
  it.runIf(shell)(
    'sh wrapper: go test asks and is replayed the second time (exit 3 kept); go build passes through unasked',
    async () => {
      const sh = (args: string[]) =>
        exec(shell!, [join(bin, 'go').replace(/\\/g, '/'), ...args], { env, cwd: root });
      const first = await sh(['test', './pkg', 'fail']);
      expect(first.status, first.stderr).toBe(3);
      expect(first.stdout).toContain('fake go test ./pkg fail');
      expect(runs(counter)).toBe(1);
      const second = await sh(['test', './pkg', 'fail']);
      expect(second.status, second.stderr).toBe(3);
      expect(second.stdout).toBe(first.stdout);
      expect(second.stderr).toMatch(/agentdeck: replayed /);
      expect(runs(counter)).toBe(1);
      const asked = entry.asks.length;
      expect((await sh(['build', './pkg'])).status).toBe(0);
      expect((await sh(['build', './pkg'])).status).toBe(0);
      expect(runs(counter)).toBe(3);
      expect(entry.asks).toHaveLength(asked);
      expect(entry.asks[0]).toMatchObject({
        road: 'capture-wrapper',
        origin: 'session',
        taskId: stand.task.taskId,
        argv: ['go', 'test', './pkg', 'fail'],
      });
    },
  );

  it.runIf(os === 'win32')(
    'cmd finds go.cmd in the wrapper dir first: asked once, replayed once',
    async () => {
      const cmd = (line: string) =>
        exec(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', line], { env, cwd: root });
      const runsBefore = runs(counter);
      const first = await cmd('go vet ./cmdpkg');
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('fake go vet ./cmdpkg');
      const second = await cmd('go vet ./cmdpkg');
      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr).toMatch(/agentdeck: replayed /);
      expect(runs(counter)).toBe(runsBefore + 1);
    },
  );
});

describe('core absent or without a check entry: the check runs and its result is spooled (F25, G22)', () => {
  const project = join(root, 'proj spool');
  const runner = fakeProject(project);
  const counter = join(root, 'spool.count');

  it('503 check-entry-absent → the runner runs with its own exit, the result lands in spool/ in the shape ingest accepts; the next ask drains it lazily', async () => {
    const sink = collectingSink();
    const stand = await startCaptureStand({ sink });
    try {
      const env = sessionEnv(stand, counter);
      const first = await runNode(runner, ['run', '--fail'], env, project);
      expect(first.status, first.stderr).toBe(1);
      expect(first.stdout).toContain('1 failed');
      const files = spoolFiles(stand.layout.spool);
      expect(files).toHaveLength(1);
      const doc = JSON.parse(readFileSync(join(stand.layout.spool, files[0]!), 'utf8')) as unknown;
      const parsed = SPOOL_RECORD.safeParse(doc);
      expect(parsed.success).toBe(true);
      expect(doc).toMatchObject({ road: 'node-preload', exit: 1, token: 'session', cwd: project });

      const second = await runNode(runner, ['run'], env, project);
      expect(second.status).toBe(0);
      expect(runs(counter)).toBe(2);
      // Вопрос второго прогона забрал файл первого; свой итог он положил после.
      expect(sink.records).toHaveLength(1);
      expect(sink.records[0]!.log).toContain('1 failed');
      expect(spoolFiles(stand.layout.spool)).toHaveLength(1);

      const drained = await ingestSpool(stand.layout.spool, sink);
      expect(drained.taken).toHaveLength(1);
      expect(spoolFiles(stand.layout.spool)).toHaveLength(0);
      expect(sink.records[1]!.log).toContain('3 passed');
    } finally {
      await stand.close();
    }
  });

  it('core unreachable (closed port) → the runner runs, the result is spooled next to procs.json', async () => {
    const home = mkdtempSync(join(root, 'home-'));
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(counter),
      NODE_OPTIONS: composeCaptureNodeOptions(undefined),
      [CAPTURE_VARS.url]: `http://127.0.0.1:${port}`,
      [CAPTURE_VARS.access]: 'some-session-token',
      [CAPTURE_VARS.procs]: join(home, 'procs.json'),
    };
    const before = runs(counter);
    const ran = await runNode(runner, ['run', '--fail'], env, project);
    expect(ran.status, ran.stderr).toBe(1);
    expect(runs(counter)).toBe(before + 1);
    const files = spoolFiles(join(home, 'spool'));
    expect(files).toHaveLength(1);
    const doc = JSON.parse(readFileSync(join(home, 'spool', files[0]!), 'utf8')) as unknown;
    expect(SPOOL_RECORD.safeParse(doc).success).toBe(true);
  });

  it('the result endpoint without a check entry answers 503 (the shim then spools)', async () => {
    const stand = await startCaptureStand();
    try {
      const got = await post(
        stand,
        '/v1/session/capture/result',
        {
          leaseId: '0199c82c-c000-7000-9494-c5517b88874a',
          checkRunId: '0199c82c-c000-7000-9494-c5517b88874b',
          exit: 0,
          signal: null,
          ms: 1,
          log: '',
        },
        stand.sessionToken,
      );
      expect(got.status).toBe(503);
      expect(got.body['code']).toBe('check-entry-absent');
    } finally {
      await stand.close();
    }
  });
});

describe('capture endpoint access: only a session token or the capture access opens it', () => {
  let stand: CaptureStand;
  const entry = recordingEntry(root);
  beforeAll(async () => {
    stand = await startCaptureStand({ entry });
  });
  afterAll(() => stand.close());

  it('no bearer → 401; a foreign bearer → 401; nothing reaches the check entry', async () => {
    expect((await post(stand, '/v1/session/capture', ask(10))).status).toBe(401);
    const foreign = await post(stand, '/v1/session/capture', ask(10), 'not-a-token');
    expect(foreign.status).toBe(401);
    expect(foreign.body['code']).toBe('capture-token-required');
    expect(entry.asks).toHaveLength(0);
  });

  it('a session token of a session the journal does not hold → 403', async () => {
    const stray = stand.tokens.mint({
      taskId: stand.task.taskId,
      sessionId: '0199c82c-c000-7000-9494-c5517b88874f',
    });
    const got = await post(stand, '/v1/session/capture', ask(10), stray);
    expect(got.status).toBe(403);
    expect(entry.asks).toHaveLength(0);
  });

  it('the body cannot name a task or step (strict shape → 400); a malformed result → 400', async () => {
    const named = await post(
      stand,
      '/v1/session/capture',
      ask(10, { taskId: stand.task.taskId }),
      stand.sessionToken,
    );
    expect(named.status).toBe(400);
    expect(named.body['code']).toBe('capture-unreadable');
    const badResult = await post(
      stand,
      '/v1/session/capture/result',
      { leaseId: 'x' },
      stand.sessionToken,
    );
    expect(badResult.status).toBe(400);
    expect(entry.asks).toHaveLength(0);
  });

  it('A2-F05: a road no shim produces (container-wrapper) is not a capture road → 400, entry not asked', async () => {
    const got = await post(
      stand,
      '/v1/session/capture',
      ask(10, { road: 'container-wrapper' }),
      stand.sessionToken,
    );
    expect(got.status).toBe(400);
    expect(entry.asks).toHaveLength(0);
  });
});

describe('pseudo-tasks: a check from a CLI the human started queues under its CLI ancestor (P91)', () => {
  const rows: (ProcessRow & { image?: string })[] = [
    { pid: 300, ppid: 1, start: 'S300', startMs: 1000, image: 'C:\\Tools\\Claude.EXE' },
    { pid: 400, ppid: 300, start: 'S400', startMs: 2000, image: 'node.exe' },
    { pid: 500, ppid: 400, start: 'S500', startMs: 3000 },
    { pid: 501, ppid: 300, start: 'S501', startMs: 2500 },
    { pid: 600, ppid: 1, start: 'S600', startMs: 500, image: 'explorer.exe' },
    // Родитель моложе ребёнка — pid 300 переиспользован: цепочка обрывается, а не идёт в чужое дерево.
    { pid: 700, ppid: 300, start: 'S700', startMs: 500 },
  ];
  const state: { unknown?: string } = {};
  const table = {
    read: async () => (state.unknown ? { unknown: state.unknown } : { value: rows }),
  };
  const images = () => ['claude'];
  let stand: CaptureStand;
  const entry = recordingEntry(root);
  beforeAll(async () => {
    stand = await startCaptureStand({ entry, table, images });
  });
  afterAll(() => stand.close());

  it('two checks under one CLI → one stable task id, pseudo.json names the ancestor, each ask in capture.log', async () => {
    const a = await post(stand, '/v1/session/capture', ask(500), stand.captureToken);
    expect(a.status).toBe(200);
    expect(a.body['kind']).toBe('run');
    const b = await post(stand, '/v1/session/capture', ask(501), stand.captureToken);
    expect(b.status).toBe(200);
    expect(entry.asks).toHaveLength(2);
    const taskId = entry.asks[0]!.taskId;
    expect(entry.asks[1]!.taskId).toBe(taskId);
    expect(entry.asks[0]).toMatchObject({
      origin: 'pseudo',
      road: 'pseudo',
      sessionId: null,
      stepId: null,
    });
    expect(taskId).not.toBe(stand.task.taskId);
    const dir = join(stand.layout.tasks, `${PSEUDO_PREFIX}${taskId}`);
    const record = JSON.parse(readFileSync(join(dir, PSEUDO_FILE), 'utf8')) as unknown;
    expect(record).toMatchObject({ v: 1, taskId, ancestor: { pid: 300, start: 'S300' } });
    expect(readFileSync(join(dir, PSEUDO_LOG), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('after a core restart over the same home the same CLI keeps its task id', async () => {
    const before = entry.asks[0]!.taskId;
    const entry2 = recordingEntry(root);
    const again = await startCaptureStand({
      root: stand.layout.root,
      entry: entry2,
      table,
      images,
    });
    try {
      const got = await post(again, '/v1/session/capture', ask(500), again.captureToken);
      expect(got.status).toBe(200);
      expect(entry2.asks[0]!.taskId).toBe(before);
    } finally {
      await again.close();
    }
  });

  it('no CLI ancestor, a reused parent pid, or an unread table → pass-through named outside the queue, entry not asked', async () => {
    const asked = entry.asks.length;
    const none = await post(stand, '/v1/session/capture', ask(600), stand.captureToken);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ kind: 'pass-through' });
    expect(String(none.body['outside'])).toMatch(/no CLI ancestor/);
    const reused = await post(stand, '/v1/session/capture', ask(700), stand.captureToken);
    expect(String(reused.body['outside'])).toMatch(/no CLI ancestor/);
    state.unknown = 'table helper down';
    try {
      const blind = await post(stand, '/v1/session/capture', ask(500), stand.captureToken);
      expect(blind.body).toMatchObject({ kind: 'pass-through' });
      expect(String(blind.body['outside'])).toMatch(/ancestry unread \(table helper down\)/);
    } finally {
      delete state.unknown;
    }
    expect(entry.asks).toHaveLength(asked);
    expect(stand.notes.filter((n) => n.event === 'capture.outside')).toHaveLength(3);
  });
});

describe('installed capture (no core session): the real shim, the real process table, the capture access (P91, P99)', () => {
  const project = join(root, 'proj installed');
  const runner = fakeProject(project);
  const counter = join(root, 'installed.count');
  const entry = recordingEntry(join(root, 'records-installed'));
  mkdirSync(join(root, 'records-installed'), { recursive: true });
  let stand: CaptureStand;
  beforeAll(async () => {
    // Таблица процессов настоящая; имя образа ядру ОС не отдаёт (названо в отчёте) — CLI здесь
    // объявлен сам тестовый процесс, родитель бегуна.
    const real = osProcessTable();
    const table = {
      read: async () => {
        const got = await real.read();
        if (!('value' in got)) return got;
        return {
          value: got.value.map((row) =>
            row.pid === process.pid ? { ...row, image: 'fake-cli.exe' } : row,
          ),
        };
      },
    };
    stand = await startCaptureStand({ entry, table, images: () => ['fake-cli'] });
    writeFileSync(
      stand.layout.procs,
      JSON.stringify({
        v: 1,
        cores: [{ url: stand.url, port: stand.port, startedAt: Date.now() }],
        servers: [],
      }),
    );
  });
  afterAll(() => stand.close());

  it('a runner under the installed NODE_OPTIONS finds the core through procs.json, queues as a pseudo-task and is replayed the second time', async () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(counter),
      NODE_OPTIONS: composeCaptureNodeOptions('--max-old-space-size=512'),
      [CAPTURE_VARS.home]: stand.layout.root,
    };
    const first = await runNode(runner, ['run', '--fail'], env, project);
    expect(first.status, first.stderr).toBe(1);
    expect(runs(counter)).toBe(1);
    const second = await runNode(runner, ['run', '--fail'], env, project);
    expect(second.status, second.stderr).toBe(1);
    expect(second.stdout).toBe(first.stdout);
    expect(runs(counter)).toBe(1);
    expect(entry.asks).toHaveLength(2);
    expect(entry.asks[0]).toMatchObject({ origin: 'pseudo', road: 'pseudo' });
    expect(entry.asks[1]!.taskId).toBe(entry.asks[0]!.taskId);
    expect(entry.results[0]!.owner).toEqual({ origin: 'pseudo', taskId: null });
    const dir = join(stand.layout.tasks, `${PSEUDO_PREFIX}${entry.asks[0]!.taskId}`);
    const record = JSON.parse(readFileSync(join(dir, PSEUDO_FILE), 'utf8')) as {
      ancestor: { pid: number };
    };
    expect(record.ancestor.pid).toBe(process.pid);
  });
});
