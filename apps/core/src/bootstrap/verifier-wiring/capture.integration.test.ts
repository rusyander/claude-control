import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { CheckRecord, QueueLease, SpoolRecord } from '@agentdeck/contracts/core/records';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCaptureStand, type CaptureStand } from '../../api/__fixtures__/capture-stand.ts';
import type { ModelCheckReply } from '../../conductor/checks/index.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { composeCaptureNodeOptions } from '../../mcp/capture-wrap.ts';
import { CAPTURE_SHIM, CAPTURE_VARS, ensureCaptureToken } from '../../platform/capture-shim.ts';
import { ensureCoreHome, type CoreHomeLayout } from '../../platform/core-home.ts';
import { commonDirSync, scratchIndexTree, workTreeOf } from '../../platform/git.ts';
import { osProcessTable, type ProcessRow } from '../../platform/process-table.ts';
import { readLoginShellPath } from '../../platform/shell-path.ts';
import {
  createSessionTokens,
  type SessionTokens,
} from '../../policy/session-tokens/session-tokens.ts';
import { SPOOL_BAD_DIR } from '../../verifier/spool/ingest.ts';
import {
  createRecordStore,
  loadVerifyKey,
  storeRoot,
  type RecordStore,
} from '../../verifier/store/index.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { buildCoreApi } from '../boot-api.ts';
import type { SessionRuntime } from '../session-runtime.ts';
import { captureEntry, REFUSE_EXIT } from './capture-entry.ts';
import { buildVerifierWiring } from './index.ts';
import { queueWiring } from './queue.ts';

/**
 * Волна 2 на настоящем пути: API ядра собран `buildCoreApi` (как в боевом ядре), вопрос захвата
 * идёт по настоящей ручке в настоящий вход проверок зоны C, реестр — настоящий профиль
 * `.agentdeck/checks.json` в настоящем git-репозитории, проверка — настоящий vitest под настоящей
 * прокладкой `capture-preload.cjs` (`NODE_OPTIONS --require`), записи — настоящее хранилище зоны A.
 * Подмены: таблица процессов псевдозадач (граница ОС) — в отдельном блоке.
 */

const VITEST = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
const ARGV = [process.execPath, VITEST, 'run', '--root', '.', '--globals'];
const DIGEST = 'a'.repeat(64);

const roots: string[] = [];
afterAll(() => {
  for (const r of roots)
    rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
}

const testFile = (counter: string, green: boolean): string =>
  [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(counter)}, 'x');`,
    "describe('outer', () => {",
    `  it('target', () => { expect(${green ? 1 : 2}).toBe(1); });`,
    '});',
    '',
  ].join('\n');

/** Репозиторий с одной проверкой в реестре — настоящий vitest с абсолютными путями. */
function repoWithCheck(root: string, counter: string): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.agentdeck'), { recursive: true });
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'sub', 'keep.txt'), 'sub\n');
  writeFileSync(join(repo, 'a.test.ts'), testFile(counter, true));
  writeFileSync(
    join(repo, '.agentdeck/checks.json'),
    `${JSON.stringify({
      v: 1,
      checks: [
        {
          id: 'unit-tests',
          class: 'test-runner',
          argv: ARGV,
          requiredAt: ['publish'],
          envAllow: ['CI'],
        },
      ],
    })}\n`,
  );
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return repo;
}

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Ребёнок без блокировки: ручка ядра живёт в этом процессе, `spawnSync` остановил бы её. */
function exec(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function shimEnv(url: string, token: string, home: CoreHomeLayout): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['CI'];
  for (const name of Object.keys(env)) if (name.startsWith('VITEST')) delete env[name];
  for (const name of Object.values(CAPTURE_VARS)) delete env[name];
  return {
    ...env,
    NODE_OPTIONS: composeCaptureNodeOptions(undefined),
    [CAPTURE_VARS.url]: url,
    [CAPTURE_VARS.access]: token,
    [CAPTURE_VARS.procs]: home.procs,
  };
}

async function post(
  url: string,
  path: string,
  body: unknown,
  bearer: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Имена прокладки по умолчанию; `CI`/`NODE_ENV`/`TZ` не заданы — как у ядра (в пине их нет). */
const UNSET = { CI: null, NODE_ENV: null, TZ: null };

const askBody = (
  cwd: string,
  argv: string[] = ARGV,
  env: Record<string, string | null> = UNSET,
) => ({
  road: 'node-preload',
  argv,
  cwd,
  envDigest: DIGEST,
  env,
  pid: 4242,
  pidStart: 1,
});

/** Все записи хранилища репозитория, по времени старта. */
function recordsOf(store: RecordStore): CheckRecord[] {
  const dir = join(store.root, 'records');
  if (!existsSync(dir)) return [];
  const out: CheckRecord[] = [];
  for (const shard of readdirSync(dir))
    for (const name of readdirSync(join(dir, shard))) {
      const rec = store.record(name.replace(/\.json$/, ''));
      if (!('value' in rec)) throw new Error(`record ${name}: ${JSON.stringify(rec)}`);
      out.push(rec.value);
    }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function storeOf(repo: string, home: CoreHomeLayout): RecordStore {
  const common = commonDirSync(repo);
  const key = loadVerifyKey(home.root);
  if (!('value' in common) || !('value' in key)) throw new Error('store not reachable');
  return createRecordStore({ root: storeRoot(common.value), key: key.value });
}

/** Хеш окружения той же функцией, что у прокладки (её имена по умолчанию). */
const shimDigest = (env: Record<string, string>): string =>
  (
    createRequire(import.meta.url)(CAPTURE_SHIM) as {
      envDigest(env: Record<string, string>, extra?: string): string;
    }
  ).envDigest(env);

/** id дерева рабочей копии — тот, что прокладка пишет в очередь и сверяет забор. */
async function treeOf(repo: string): Promise<string> {
  const tree = await scratchIndexTree(repo);
  if (!('value' in tree)) throw new Error(`tree of ${repo}: ${JSON.stringify(tree)}`);
  return tree.value;
}

const runs = (counter: string): number =>
  existsSync(counter) ? readFileSync(counter, 'utf8').length : 0;

function commonOf(repo: string): string {
  const common = commonDirSync(repo);
  if (!('value' in common)) throw new Error(`common dir of ${repo}: ${JSON.stringify(common)}`);
  return common.value;
}

interface Stand {
  root: string;
  home: CoreHomeLayout;
  repo: string;
  counter: string;
  registry: TaskRegistry;
  task: LiveTask;
  other: LiveTask;
  tokens: SessionTokens;
  sessionId: string;
  sessionToken: string;
  otherToken: string;
  captureToken: string;
  app: FastifyInstance;
  url: string;
  /** Заметки журнала ядра, которые API отдал при сборке как в боевом ядре (`boot.ts`). */
  notes: { event: string; data: Record<string, unknown> }[];
}

async function bootStand(
  make: (root: string, counter: string) => string = repoWithCheck,
): Promise<Stand> {
  const root = mkdtempSync(join(tmpdir(), 'adk-capw2-'));
  roots.push(root);
  const home = ensureCoreHome(join(root, 'home'));
  const counter = join(root, 'vitest.count');
  const repo = make(root, counter);
  const registry = createTaskRegistry(home.tasks, deps());
  const repos = [{ repoKey: 'r1', path: repo, baseRef: 'main' }];
  const task = await registry.create({ ...CREATED, repos });
  const other = await registry.create({ ...CREATED, repos });
  const coreToken = randomBytes(24).toString('base64url');
  const tokens = createSessionTokens(coreToken);
  const mine = seedSession(task, { stepKind: 'work' });
  const theirs = seedSession(other, { stepKind: 'work' });
  const sessions = { permitDeps: () => undefined } as unknown as SessionRuntime;
  const notes: Stand['notes'] = [];
  const note = (event: string, data: Record<string, unknown>) => notes.push({ event, data });
  const app = buildCoreApi({
    registry,
    layout: home,
    coreToken,
    sessionTokens: tokens,
    sessions,
    health: {
      build: 'test',
      bootId: newId(),
      pid: process.pid,
      startedAt: Date.now(),
      home: home.root,
    },
    windows: new WindowBook(),
    note,
    verifier: buildVerifierWiring({ registry, layout: home, note }),
    // Дирижёра стенд не запускает: среды деления нет.
    split: () => undefined,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return {
    root,
    home,
    repo,
    counter,
    registry,
    task,
    other,
    tokens,
    sessionId: mine.sessionId,
    sessionToken: tokens.mint({ taskId: task.taskId, sessionId: mine.sessionId }),
    otherToken: tokens.mint({ taskId: other.taskId, sessionId: theirs.sessionId }),
    captureToken: ensureCaptureToken(home.root).token,
    app,
    url: `http://127.0.0.1:${port}`,
    notes,
  };
}

describe('capture road reaches the check entry: booted core API, real registry repo, real vitest under the shim (wave 2)', () => {
  let s: Stand;
  beforeAll(async () => {
    s = await bootStand();
  }, 60_000);
  afterAll(async () => {
    await s.app.close();
    s.task.close();
    s.other.close();
  });

  it('a spooled run is ingested on the next ask as an unattended record; one outside any work tree or from a sub-folder the check does not run in goes to spool/bad', async () => {
    mkdirSync(s.home.spool, { recursive: true });
    const spooled: SpoolRecord = {
      v: 1,
      spoolId: '1-2-3',
      at: Date.now(),
      road: 'node-preload',
      argv: ARGV,
      cwd: s.repo,
      tree: await treeOf(s.repo),
      envDigest: shimDigest({}),
      envNames: ['CI', 'NODE_ENV', 'TZ'],
      exit: 0,
      ms: 7,
      log: 'spooled green\n',
      truncated: false,
      token: 'session',
    };
    writeFileSync(join(s.home.spool, '1-2-3.json'), JSON.stringify(spooled));
    const nowhere = mkdtempSync(join(tmpdir(), 'adk-capw2-nowhere-'));
    roots.push(nowhere);
    writeFileSync(
      join(s.home.spool, '1-2-4.json'),
      JSON.stringify({ ...spooled, spoolId: '1-2-4', cwd: nowhere }),
    );
    // Та же команда из подпапки — другой прогон, не запись `unit-tests` (та гоняется из корня).
    writeFileSync(
      join(s.home.spool, '1-2-5.json'),
      JSON.stringify({ ...spooled, spoolId: '1-2-5', cwd: join(s.repo, 'sub') }),
    );
    // Любой вопрос забирает очередь — даже идущий насквозь.
    const asked = await post(s.url, '/v1/session/capture', askBody(nowhere), s.sessionToken);
    expect(asked.status).toBe(200);
    expect(asked.body['kind']).toBe('pass-through');
    // Непойманная дорога и итог забора названы в журнале ядра, не немы (A2-F03).
    expect(s.notes.map((n) => n.event)).toEqual(
      expect.arrayContaining(['capture.outside', 'capture.spool']),
    );
    const drained = s.notes.find((n) => n.event === 'capture.spool')!.data;
    expect(drained['taken']).toBe(1);
    expect((drained['bad'] as { file: string }[]).map((b) => basename(b.file)).sort()).toEqual([
      '1-2-4.json',
      '1-2-5.json',
    ]);

    expect(readdirSync(s.home.spool).filter((n) => n.endsWith('.json'))).toEqual([]);
    expect(
      readdirSync(join(s.home.spool, SPOOL_BAD_DIR))
        .filter((n) => n.endsWith('.json'))
        .sort(),
    ).toEqual(['1-2-4.json', '1-2-5.json']);
    const records = recordsOf(storeOf(s.repo, s.home));
    expect(records).toHaveLength(1);
    const rec = records[0] as CheckRecord;
    expect(rec).toMatchObject({
      checkId: 'unit-tests',
      unit: '.',
      origin: 'unattended',
      verdict: { kind: 'pass' },
      exit: 0,
      taskId: null,
      checkRunId: null,
      argv: ARGV,
    });
    expect(storeOf(s.repo, s.home).log(rec.id)).toEqual({ value: 'spooled green\n' });
    expect(runs(s.counter)).toBe(0);

    // Файл забран, но не снят (замок Windows, сбой удаления) — следующий забор находит ту же
    // запись, а не пишет вторую `unattended` (A2-F07); файл уходит.
    writeFileSync(join(s.home.spool, '1-2-3.json'), JSON.stringify(spooled));
    const again = await post(s.url, '/v1/session/capture', askBody(nowhere), s.sessionToken);
    expect(again.status).toBe(200);
    expect(readdirSync(s.home.spool).filter((n) => n.endsWith('.json'))).toEqual([]);
    expect(recordsOf(storeOf(s.repo, s.home)).map((r) => r.id)).toEqual([rec.id]);

    // Настоящий vitest под прокладкой из папки вне репозиториев задачи: идёт насквозь, а причина —
    // одной строкой stderr (A2-F03), не молча.
    const outside = await exec(ARGV.slice(1), shimEnv(s.url, s.sessionToken, s.home), nowhere);
    expect(outside.stderr).toMatch(/agentdeck: not captured — cwd .+ is not in a git work tree/);
    expect(runs(s.counter)).toBe(0);
  }, 120_000);

  it('a registered check asked through the shim runs once under a lease into a session record; the same ask replays it, vitest not started; an unattended green on the same key is never replayed', async () => {
    const env = shimEnv(s.url, s.sessionToken, s.home);
    const first = await exec(ARGV.slice(1), env, s.repo);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).not.toMatch(/agentdeck: replayed/);
    // Зелёная запись очереди лежит на том же ключе — и всё равно прогон был (G13).
    expect(runs(s.counter)).toBe(1);
    const store = storeOf(s.repo, s.home);
    const all = recordsOf(store);
    const session = all.filter((r) => r.origin === 'session');
    expect(session).toHaveLength(1);
    const rec = session[0] as CheckRecord;
    expect(rec).toMatchObject({
      checkId: 'unit-tests',
      verdict: { kind: 'pass' },
      exit: 0,
      taskId: s.task.taskId,
      envPrepared: false,
    });
    expect(all.find((r) => r.origin === 'unattended')?.key).toBe(rec.key);
    expect(Object.values(s.task.state.checks).map((c) => c.recordId)).toContain(rec.id);

    const second = await exec(ARGV.slice(1), env, s.repo);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toContain(`agentdeck: replayed ${rec.id}`);
    expect(second.stdout).toMatch(/1 passed/);
    expect(runs(s.counter)).toBe(1);
  }, 120_000);

  it('a red run keeps its exit: recorded red, the same ask replays exit 1 without running', async () => {
    writeFileSync(join(s.repo, 'a.test.ts'), testFile(s.counter, false));
    const env = shimEnv(s.url, s.sessionToken, s.home);
    const before = runs(s.counter);
    const red = await exec(ARGV.slice(1), env, s.repo);
    expect(red.status, red.stderr).toBe(1);
    expect(runs(s.counter)).toBe(before + 1);
    // Итог аренды принят входом и записан — до повторного вопроса: без записи тот же ключ числится
    // в полёте, и повтор ждал бы чужой прогон до срока присоединения, а не падал.
    const recorded = recordsOf(storeOf(s.repo, s.home)).filter(
      (r) => r.origin === 'session' && r.verdict.kind === 'fail',
    );
    expect(recorded).toHaveLength(1);
    const again = await exec(ARGV.slice(1), env, s.repo);
    expect(again.status, again.stderr).toBe(1);
    expect(again.stderr).toMatch(/agentdeck: replayed /);
    expect(runs(s.counter)).toBe(before + 1);
    const reds = recordsOf(storeOf(s.repo, s.home)).filter((r) => r.verdict.kind === 'fail');
    expect(reds).toHaveLength(1);
    expect(reds[0]).toMatchObject({ origin: 'session', exit: 1 });
  }, 120_000);

  it('the result of a lease is taken only from its own task: another task, the capture access or a wrong lease → 409; the owner → recorded, replayed from its log', async () => {
    writeFileSync(join(s.repo, 'a.test.ts'), testFile(s.counter, true));
    writeFileSync(join(s.repo, 'note.md'), 'edit\n');
    const asked = await post(s.url, '/v1/session/capture', askBody(s.repo), s.sessionToken);
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ kind: 'run', resultUrl: '/v1/session/capture/result' });
    const lease = { leaseId: asked.body['leaseId'], checkRunId: asked.body['checkRunId'] };
    // Обёртка обрезала вывод — запись помнит об этом, как на дороге спула (B2-F02, живая дорога).
    const result = {
      ...lease,
      exit: 3,
      signal: null,
      ms: 12,
      log: 'caller log\n',
      truncated: true,
    };
    const path = '/v1/session/capture/result';

    const foreign = await post(s.url, path, result, s.otherToken);
    expect(foreign.status).toBe(409);
    const pseudo = await post(s.url, path, result, s.captureToken);
    expect(pseudo.status).toBe(409);
    const wrong = await post(s.url, path, { ...result, leaseId: newId() }, s.sessionToken);
    expect(wrong.status).toBe(409);

    const taken = await post(s.url, path, result, s.sessionToken);
    expect(taken).toEqual({ status: 200, body: { taken: true } });
    const twice = await post(s.url, path, result, s.sessionToken);
    expect(twice.status).toBe(409);

    const replay = await post(s.url, '/v1/session/capture', askBody(s.repo), s.sessionToken);
    expect(replay.body).toMatchObject({ kind: 'replay', exit: 3 });
    const logPath = replay.body['logPath'] as string;
    expect(gunzipSync(readFileSync(logPath)).toString('utf8')).toBe('caller log\n');
    const rec = storeOf(s.repo, s.home).record(replay.body['recordId'] as string);
    expect(rec).toMatchObject({
      value: { origin: 'session', exit: 3, verdict: { kind: 'fail' }, taskId: s.task.taskId },
    });
    expect('value' in rec && rec.value.log.truncated).toBe(true);
  }, 60_000);

  it('what the core cannot file passes through named: cwd outside any work tree, a repository foreign to the task, a sub-folder the check does not run in', async () => {
    const nowhere = mkdtempSync(join(tmpdir(), 'adk-capw2-out-'));
    roots.push(nowhere);
    const out = await post(s.url, '/v1/session/capture', askBody(nowhere), s.sessionToken);
    expect(out.body).toMatchObject({ kind: 'pass-through' });
    expect(out.body['outside']).toMatch(/not in a git work tree/);

    const foreign = join(nowhere, 'foreign');
    execFileSync('git', ['init', '-q', foreign], { stdio: 'ignore' });
    const other = await post(s.url, '/v1/session/capture', askBody(foreign), s.sessionToken);
    expect(other.body).toMatchObject({ kind: 'pass-through' });
    expect(other.body['outside']).toMatch(/not inside a repository of task/);

    const sub = await post(
      s.url,
      '/v1/session/capture',
      askBody(join(s.repo, 'sub')),
      s.sessionToken,
    );
    expect(sub.body).toMatchObject({ kind: 'pass-through' });
    expect(sub.body['outside']).toMatch(/ran in sub, while unit-tests runs in \./);
  }, 60_000);

  it('B2-F01/B2-F02: a spooled run is recorded only under the tree and env it ran with — a tree edited before the drain or an env off the core pin goes to spool/bad named; a cut log stays truncated', async () => {
    mkdirSync(s.home.spool, { recursive: true });
    const before = recordsOf(storeOf(s.repo, s.home)).length;
    const base: SpoolRecord = {
      v: 1,
      spoolId: '7-7-1',
      at: Date.now(),
      road: 'node-preload',
      argv: ARGV,
      cwd: s.repo,
      tree: await treeOf(s.repo),
      envDigest: shimDigest({}),
      envNames: ['CI', 'NODE_ENV', 'TZ'],
      exit: 1,
      ms: 11,
      log: 'red head\n[agentdeck: 9 bytes cut]\nred tail\n',
      truncated: true,
      token: 'session',
    };
    const spoolFile = (rec: SpoolRecord) =>
      writeFileSync(join(s.home.spool, `${rec.spoolId}.json`), JSON.stringify(rec));
    spoolFile(base);
    // Тот же прогон под CI=1: пин ядра его не знает — ключа под чужим окружением нет.
    spoolFile({ ...base, spoolId: '7-7-2', ms: 12, envDigest: shimDigest({ CI: '1' }) });
    const nowhere = mkdtempSync(join(tmpdir(), 'adk-capw2-b2f01-'));
    roots.push(nowhere);
    const badOf = () => {
      const notes = s.notes.filter((n) => n.event === 'capture.spool');
      return (notes.at(-1)?.data['bad'] ?? []) as { file: string; reason: string }[];
    };
    await post(s.url, '/v1/session/capture', askBody(nowhere), s.sessionToken);
    expect(badOf().map((b) => basename(b.file))).toEqual(['7-7-2.json']);
    expect(badOf()[0]!.reason).toMatch(/env .*differs from the core pin/);
    const recs = recordsOf(storeOf(s.repo, s.home));
    expect(recs).toHaveLength(before + 1);
    const taken = recs.find((r) => r.ms === 11) as CheckRecord;
    expect(taken).toMatchObject({ origin: 'unattended', exit: 1, verdict: { kind: 'fail' } });
    expect(taken.log.truncated).toBe(true);

    // Красный прогон на X лёг в очередь; человек правит код (Y) до забора — записи на Y нет.
    spoolFile({ ...base, spoolId: '7-7-3', ms: 13, truncated: false });
    const file = join(s.repo, 'a.test.ts');
    const kept = readFileSync(file, 'utf8');
    writeFileSync(file, `${kept}// fixed\n`);
    try {
      await post(s.url, '/v1/session/capture', askBody(nowhere), s.sessionToken);
      expect(badOf().map((b) => basename(b.file))).toEqual(['7-7-3.json']);
      expect(badOf()[0]!.reason).toMatch(/tree .*moved since the run/);
      expect(recordsOf(storeOf(s.repo, s.home))).toHaveLength(before + 1);
    } finally {
      writeFileSync(file, kept);
    }
  }, 60_000);
});

/** Две единицы и проверка по единицам: посреди работы гонится только изменённая (04:56). */
function repoWithUnits(root: string): string {
  const repo = join(root, 'repo');
  for (const dir of ['.agentdeck', 'pa', 'pb']) mkdirSync(join(repo, dir), { recursive: true });
  writeFileSync(join(repo, 'pa', 'x.txt'), 'a\n');
  writeFileSync(join(repo, 'pb', 'x.txt'), 'b\n');
  writeFileSync(join(repo, 'probe.mjs'), 'process.exit(0);\n');
  writeFileSync(
    join(repo, '.agentdeck/checks.json'),
    `${JSON.stringify({
      v: 1,
      units: { a: { paths: ['pa'] }, b: { paths: ['pb'] } },
      checks: [
        { id: 'pkg', class: 'static', unit: 'package', argv: ['node', 'probe.mjs', '{units}'] },
      ],
    })}\n`,
  );
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return repo;
}

describe('mid-task narrowing on the capture road: a unit outside the changed scope (04:56)', () => {
  let s: Stand;
  beforeAll(async () => {
    s = await bootStand(repoWithUnits);
  }, 60_000);
  afterAll(async () => {
    await s.app.close();
    s.task.close();
    s.other.close();
  });

  it('nothing changed yet → refused with its own exit and the reason, never a fake green; one changed unit → narrowed to its argv under a lease', async () => {
    const asked = (unit: string) => askBody(s.repo, ['node', 'probe.mjs', unit]);
    const none = await post(s.url, '/v1/session/capture', asked('a'), s.sessionToken);
    expect(none.body).toMatchObject({ kind: 'refuse', exit: REFUSE_EXIT });
    expect(JSON.stringify(none.body['unmet'])).toMatch(/changed units: none/);

    writeFileSync(join(s.repo, 'pb', 'x.txt'), 'b2\n');
    const narrowed = await post(s.url, '/v1/session/capture', asked('a'), s.sessionToken);
    expect(narrowed.body).toMatchObject({
      kind: 'narrow',
      argv: ['node', 'probe.mjs', 'b'],
      resultUrl: '/v1/session/capture/result',
    });
    const result = {
      leaseId: narrowed.body['leaseId'],
      checkRunId: narrowed.body['checkRunId'],
      exit: 0,
      signal: null,
      ms: 3,
      log: 'b ok\n',
    };
    const taken = await post(s.url, '/v1/session/capture/result', result, s.sessionToken);
    expect(taken.body).toEqual({ taken: true });
    const rec = recordsOf(storeOf(s.repo, s.home));
    expect(rec.map((r) => [r.checkId, r.unit, r.origin, r.argv.at(-1)])).toEqual([
      ['pkg', 'b', 'session', 'b'],
    ]);
  }, 60_000);
});

describe('pseudo-task capture reaches the same entry: background class, pseudo record, replay (04:42)', () => {
  const rows: (ProcessRow & { image?: string })[] = [
    { pid: 300, ppid: 1, start: 'S300', startMs: 1000, image: 'C:\\Tools\\Claude.EXE' },
    { pid: 500, ppid: 300, start: 'S500', startMs: 3000 },
  ];
  let stand: CaptureStand;
  let repo: string;
  let home: CoreHomeLayout;
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'adk-capw2p-'));
    roots.push(root);
    home = ensureCoreHome(join(root, 'home'));
    repo = repoWithCheck(root, join(root, 'vitest.count'));
    const queue = queueWiring({ registry: { live: () => undefined }, layout: home });
    stand = await startCaptureStand({
      root: home.root,
      table: { read: async () => ({ value: rows }) },
      images: () => ['claude'],
      entry: captureEntry({
        queue,
        registry: { open: async () => ({ refused: 'no core task in a pseudo test' }) },
        workTree: (dir) => workTreeOf(dir),
        commonDir: commonDirSync,
        now: Date.now,
      }),
    });
  }, 60_000);
  afterAll(() => stand.close());

  it('a CLI-run check leases under its pseudo-task, the capture access reports it (a session token cannot), the record is pseudo, the same ask replays', async () => {
    const asked = await post(
      stand.url,
      '/v1/session/capture',
      { ...askBody(repo), pid: 500 },
      stand.captureToken,
    );
    expect(asked.body).toMatchObject({ kind: 'run' });
    // Аренда псевдозадачи — в классе `background` (04:42): чужой CLI не обгоняет работу задач ядра.
    const held = JSON.parse(
      readFileSync(
        join(home.queue, 'check', 'leases', `${String(asked.body['leaseId'])}.json`),
        'utf8',
      ),
    ) as QueueLease;
    expect(held.ticket).toMatchObject({ class: 'background', kind: 'check' });
    expect(held.ticket.project).toBe(commonOf(repo));
    const result = {
      leaseId: asked.body['leaseId'],
      checkRunId: asked.body['checkRunId'],
      exit: 0,
      signal: null,
      ms: 5,
      log: 'pseudo log\n',
    };
    const bySession = await post(
      stand.url,
      '/v1/session/capture/result',
      result,
      stand.sessionToken,
    );
    expect(bySession.status).toBe(409);
    const taken = await post(stand.url, '/v1/session/capture/result', result, stand.captureToken);
    expect(taken.body).toEqual({ taken: true });

    const replay = await post(
      stand.url,
      '/v1/session/capture',
      { ...askBody(repo), pid: 500 },
      stand.captureToken,
    );
    expect(replay.body).toMatchObject({ kind: 'replay', exit: 0 });
    const rec = storeOf(repo, home).record(replay.body['recordId'] as string);
    if (!('value' in rec)) throw new Error('pseudo record missing');
    expect(rec.value).toMatchObject({ origin: 'pseudo', verdict: { kind: 'pass' } });
    const pseudoDirs = readdirSync(home.tasks).filter((n) => n.startsWith('session-'));
    expect(pseudoDirs).toEqual([`session-${rec.value.taskId}`]);

    // Тот же вопрос из CLI с `CI=1` — другое окружение, другой ключ: прогон, не повтор.
    const ci = await post(
      stand.url,
      '/v1/session/capture',
      { ...askBody(repo, ARGV, { ...UNSET, CI: '1' }), pid: 500 },
      stand.captureToken,
    );
    expect(ci.body).toMatchObject({ kind: 'run' });
    const ciTaken = await post(
      stand.url,
      '/v1/session/capture/result',
      { ...result, leaseId: ci.body['leaseId'], checkRunId: ci.body['checkRunId'] },
      stand.captureToken,
    );
    expect(ciTaken.body).toEqual({ taken: true });
  }, 60_000);
});

const PROBE = [process.execPath, 'probe.mjs'];
/** Значение, которого не должно быть ни в одном файле записи: в ключ идёт только хеш (04:91). */
const CI_VALUE = 'ci-value-never-stored';

/** Проверка, чей исход зависит от `CI` и `PATH` (`envAllow`): ключ несёт хеши их значений. */
function repoWithEnvCheck(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.agentdeck'), { recursive: true });
  writeFileSync(join(repo, 'probe.mjs'), 'process.exit(0);\n');
  writeFileSync(
    join(repo, '.agentdeck/checks.json'),
    `${JSON.stringify({
      v: 1,
      checks: [
        {
          id: 'envd',
          class: 'static',
          argv: PROBE,
          requiredAt: ['publish'],
          envAllow: ['CI', 'PATH'],
        },
      ],
    })}\n`,
  );
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return repo;
}

describe('caller env in the check key: a capture run is keyed by the caller env over the core pin (03:124, 04:91)', () => {
  let s: Stand;
  beforeAll(async () => {
    s = await bootStand(repoWithEnvCheck);
  }, 60_000);
  afterAll(async () => {
    await s.app.close();
    s.task.close();
    s.other.close();
  });

  const ask = (env: Record<string, string | null>) =>
    post(s.url, '/v1/session/capture', askBody(s.repo, PROBE, env), s.sessionToken);

  /** Итог аренды владельцем — до следующего вопроса того же ключа (иначе он числится в полёте). */
  async function finish(asked: { body: Record<string, unknown> }): Promise<void> {
    const taken = await post(
      s.url,
      '/v1/session/capture/result',
      {
        leaseId: asked.body['leaseId'],
        checkRunId: asked.body['checkRunId'],
        exit: 0,
        signal: null,
        ms: 2,
        log: 'caller ok\n',
      },
      s.sessionToken,
    );
    expect(taken.body).toEqual({ taken: true });
  }

  it('the same env as the core replays the core-run record across roads (G13), a differently cased PATH included; CI=1 or an unset pinned name → own key, run under a lease, never the core record; values never stored', async () => {
    const w = queueWiring({ registry: { live: () => s.task }, layout: s.home });
    const bound = bindingOf(s.task, s.sessionId);
    if (!('binding' in bound)) throw new Error(bound.reason);
    const core = (await w.check(s.task, bound.binding, { checkId: 'envd' })) as ModelCheckReply;
    expect(core).toMatchObject({ verdict: 'pass' });
    expect(core.recordId).not.toBeNull();

    const same = await ask(UNSET);
    expect(same.body).toMatchObject({ kind: 'replay', recordId: core.recordId });
    // Та же переменная Windows в другом регистре и с тем же значением — тот же ключ.
    const path = (await readLoginShellPath()).path;
    const cased = await ask({ ...UNSET, Path: path });
    expect(cased.body).toMatchObject({ kind: 'replay', recordId: core.recordId });

    const ci = await ask({ ...UNSET, CI: CI_VALUE });
    expect(ci.body).toMatchObject({ kind: 'run' });
    await finish(ci);
    const ciAgain = await ask({ ...UNSET, CI: CI_VALUE });
    expect(ciAgain.body['kind']).toBe('replay');
    expect(ciAgain.body['recordId']).not.toBe(core.recordId);

    // Имя, заданное у ядра (PATH пина), у вызывающего не задано (`null`) — тоже свой ключ.
    const noPath = await ask({ ...UNSET, PATH: null });
    expect(noPath.body).toMatchObject({ kind: 'run' });
    await finish(noPath);
    expect((await ask(UNSET)).body).toMatchObject({ kind: 'replay', recordId: core.recordId });

    const store = storeOf(s.repo, s.home);
    const all = recordsOf(store);
    const coreRec = all.find((r) => r.id === core.recordId) as CheckRecord;
    const ciRec = all.find((r) => r.id === ciAgain.body['recordId']) as CheckRecord;
    expect(all.map((r) => r.origin).sort()).toEqual(['core', 'session', 'session']);
    expect(new Set(all.map((r) => r.key)).size).toBe(3);
    expect(Object.keys(coreRec.parts.env)).toEqual(['PATH']);
    expect(Object.keys(ciRec.parts.env).sort()).toEqual(['CI', 'PATH']);
    expect(ciRec.parts.env['PATH']).toBe(coreRec.parts.env['PATH']);
    const files = readdirSync(join(store.root, 'records'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => readFileSync(join(d.parentPath, d.name), 'utf8'));
    expect(files).toHaveLength(3);
    for (const text of files) expect(text).not.toContain(CI_VALUE);
  }, 120_000);
});

describe('A2-F02: the booted core identifies a real CLI ancestor by its image (adapter images + OS process table)', () => {
  let s: Stand;
  const kids: { kill(): boolean }[] = [];
  beforeAll(async () => {
    s = await bootStand();
  }, 60_000);
  afterAll(async () => {
    for (const k of kids) k.kill();
    await s.app.close();
    s.task.close();
    s.other.close();
  });

  /** Копия node под именем образа CLI (`claude.exe`), её ребёнок живёт, пока его не снимут. */
  async function cliWithChild(): Promise<{ cli: number; child: number }> {
    const dir = join(s.root, 'cli-bin');
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    copyFileSync(process.execPath, exe);
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.env.REAL_NODE, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(c.pid) + "\\n");',
      "process.on('SIGTERM', () => { c.kill(); process.exit(0); });",
      'setInterval(() => { if (c.exitCode !== null) process.exit(0); }, 200);',
    ].join('\n');
    const cli = spawn(exe, ['-e', script], {
      env: { ...process.env, REAL_NODE: process.execPath },
      windowsHide: true,
    });
    kids.push(cli);
    const child = await new Promise<number>((resolve, reject) => {
      cli.stdout.setEncoding('utf8').once('data', (c: string) => resolve(Number(c.trim())));
      cli.once('error', reject);
    });
    kids.push({ kill: () => process.kill(child) });
    return { cli: cli.pid as number, child };
  }

  it('a check whose caller descends from `claude.exe` leases under a pseudo-task of that process in the background class; before A2-F02 no image was read and it ran uncaptured', async () => {
    const { cli, child } = await cliWithChild();
    const rows = await osProcessTable().read();
    if (!('value' in rows)) throw new Error(JSON.stringify(rows));
    const own = rows.value.find((r) => r.pid === child);
    expect(own).toBeDefined();
    const asked = await post(
      s.url,
      '/v1/session/capture',
      { ...askBody(s.repo), pid: child, pidStart: own!.startMs },
      s.captureToken,
    );
    expect(asked.body).toMatchObject({ kind: 'run' });
    const held = JSON.parse(
      readFileSync(
        join(s.home.queue, 'check', 'leases', `${String(asked.body['leaseId'])}.json`),
        'utf8',
      ),
    ) as QueueLease;
    expect(held.ticket).toMatchObject({ class: 'background', kind: 'check' });
    const pseudo = readdirSync(s.home.tasks).filter((n) => n.startsWith('session-'));
    expect(pseudo).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(s.home.tasks, pseudo[0]!, 'pseudo.json'), 'utf8'),
    ) as { ancestor: { pid: number; image?: string } };
    expect(record.ancestor.pid).toBe(cli);
    expect(record.ancestor.image?.toLowerCase()).toMatch(/^claude(\.exe)?$/);
  }, 60_000);
});

/** Профиль знает команду менеджера (`pnpm run test`), прокладка видит argv бегуна под node. */
function repoWithScript(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.agentdeck'), { recursive: true });
  writeFileSync(join(repo, 'probe.mjs'), 'process.exit(0);\n');
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'p', scripts: { test: 'vitest run --root . --globals' } })}\n`,
  );
  writeFileSync(
    join(repo, '.agentdeck/checks.json'),
    `${JSON.stringify({
      v: 1,
      checks: [{ id: 'test', class: 'test-runner', argv: ['pnpm', 'run', 'test'] }],
    })}\n`,
  );
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return repo;
}

describe('A2-F01: a node-level argv on the preload road is mapped to the registry script entry; a derived entry keys the caller env', () => {
  let s: Stand;
  beforeAll(async () => {
    s = await bootStand(repoWithScript);
  }, 60_000);
  afterAll(async () => {
    await s.app.close();
    s.task.close();
    s.other.close();
  });

  async function finish(asked: { body: Record<string, unknown> }): Promise<void> {
    const taken = await post(
      s.url,
      '/v1/session/capture/result',
      {
        leaseId: asked.body['leaseId'],
        checkRunId: asked.body['checkRunId'],
        exit: 0,
        signal: null,
        ms: 2,
        log: 'ok\n',
      },
      s.sessionToken,
    );
    expect(taken.body).toEqual({ taken: true });
  }

  it('`node …/vitest.mjs run --root . --globals` under `"test": "vitest run --root . --globals"` is the `pnpm run test` entry: recorded as `test`, the same ask replays it', async () => {
    const asked = await post(s.url, '/v1/session/capture', askBody(s.repo), s.sessionToken);
    expect(asked.body).toMatchObject({ kind: 'run' });
    await finish(asked);
    const rec = recordsOf(storeOf(s.repo, s.home));
    expect(rec.map((r) => [r.checkId, r.origin])).toEqual([['test', 'session']]);
    const again = await post(s.url, '/v1/session/capture', askBody(s.repo), s.sessionToken);
    expect(again.body).toMatchObject({ kind: 'replay', recordId: rec[0]!.id });
  }, 60_000);

  it('a derived entry: CI=1 is its own key, never a replay of the record taken without it', async () => {
    const before = recordsOf(storeOf(s.repo, s.home)).length;
    const plain = await post(s.url, '/v1/session/capture', askBody(s.repo, PROBE), s.sessionToken);
    expect(plain.body).toMatchObject({ kind: 'run' });
    await finish(plain);
    const ci = await post(
      s.url,
      '/v1/session/capture',
      askBody(s.repo, PROBE, { ...UNSET, CI: '1' }),
      s.sessionToken,
    );
    expect(ci.body).toMatchObject({ kind: 'run' });
    await finish(ci);
    const rec = recordsOf(storeOf(s.repo, s.home)).slice(before);
    expect(rec.map((r) => r.checkId.startsWith('captured:'))).toEqual([true, true]);
    expect(new Set(rec.map((r) => r.key)).size).toBe(2);
    expect(Object.keys(rec[1]!.parts.env)).toContain('CI');
  }, 60_000);
});
