import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { ServiceRecipe } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import { actionReaders } from '../bootstrap/action-readers.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { openFresh, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import {
  EPHEMERAL_LABEL,
  containerPresent,
  engineHandle,
  listByLabels,
  runEngine,
  type EngineHandle,
} from '../platform/container-engine.ts';
import { deadSocket, localImageOf, PG_CANDIDATES } from '../platform/__fixtures__/engine-stub.ts';
import { identityOfPid } from '../platform/process-identity.ts';
import type { CommandProof } from '../policy/authority/authority.ts';
import { createStandRegistry, readHealth } from '../verifier/stand/index.ts';
import { processCommand } from './commands.ts';
import { commandEnv } from './commands/__fixtures__/command-env.ts';
import { reconcileTask } from './reconcile.ts';
import {
  attachStand,
  createEnsureServices,
  engineRoadProbe,
  releaseServices,
  type ContainerHint,
} from './services.ts';

/**
 * Сервисы задачи в дирижёре. P58: нет движка / движок молчит / рецепта нет — `unknown` с
 * причиной, действий нет, зелёного нет. P40/P90: команда `release-resource` (G25) идёт через
 * настоящий `processCommand` и снимает ресурс с чтением назад — каталог, стенд (настоящий
 * процесс с настоящим адресом здоровья); на настоящем движке — контейнер сервиса задачи
 * поднят, записан ресурсом, снят в конце задачи и прочитан назад; сверка после краха читает
 * контейнер по меткам. P44 `container.by-label`: движок не ответил — `retry`, не «не было».
 */

const ZONE_LABEL = 'agentdeck.zone-f-test';
// Значение метки — своё у прогона файла: уборка `afterAll` соседнего файла (параллельно) иначе
// снесла бы мой живой контейнер посреди работы (pg_dump exit 137).
const ZONE_RUN = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const proof = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});
const temps: string[] = [];
const children: ChildProcess[] = [];

function release(task: LiveTask, rid: string, cmdId = newId()): CommandEnvelope {
  return {
    cmdId,
    kind: 'release-resource',
    target: { taskId: task.taskId },
    fields: { rid },
    proof: {},
  };
}

function kinds(task: LiveTask): string[] {
  return readJournalLines(task.dir, task.taskId).lines.map((l) => l.kind);
}

function addResource(task: LiveTask, kind: 'tmpdir' | 'lease' | 'stand', ref: string): string {
  const rid = newId();
  task.append({
    kind: 'resource.created',
    actor: 'core',
    data: { rid, kind, owner: 'core', release: 'task-end', ref },
  });
  return rid;
}

describe('P58 ensureServices refuses without a working engine (no action, named reason)', () => {
  const recipe: ServiceRecipe = {
    name: 'db',
    source: 'compose',
    image: 'postgres:15-alpine',
    ports: [5432],
    env: {},
    scheme: 'postgres',
  };
  it.each([
    ['engine absent', { absent: true as const }, /^engine-absent: no docker or podman/],
    [
      'engine down (VM stopped)',
      { unknown: 'engine-down: docker: server not answering' },
      /^engine-down: docker/,
    ],
    ['engine read timed out', { unknown: 'timeout after 10000 ms' }, /^engine-down: timeout/],
  ])('%s → unknown, no container-start in the journal', async (_name, engine, reason) => {
    const { task } = await openFresh();
    const ensure = createEnsureServices({
      task: () => task,
      recipes: () => [recipe],
      engine: async () => engine,
    });
    expect(await ensure(task.taskId, [{ service: 'db' }])).toMatchObject({
      unknown: expect.stringMatching(reason),
    });
    expect(kinds(task)).not.toContain('action.started');
    task.close();
  });
  it('a need without a recipe → unknown recipe-missing before the engine is even asked', async () => {
    const { task } = await openFresh();
    let asked = 0;
    const ensure = createEnsureServices({
      task: () => task,
      recipes: () => [recipe],
      engine: async () => {
        asked += 1;
        return { absent: true };
      },
    });
    expect(await ensure(task.taskId, [{ service: 'cache' }])).toEqual({
      unknown: 'recipe-missing: cache',
    });
    expect(asked).toBe(0);
    task.close();
  });
  it('preflight road: absent → fail with the fix, engine-down → fail, timeout → unknown', async () => {
    const run =
      (stdout: string, code = 0) =>
      async () => ({ ok: true as const, code, stdout, stderr: '', timedOut: false as const });
    const none = (() => ({ ok: false, absent: true, searched: [] })) as never;
    const docker = (() => ({
      ok: true,
      kind: 'native',
      file: 'docker',
      prefix: [],
      found: 'docker',
    })) as never;
    expect(await engineRoadProbe({ resolve: none })()).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/install Docker Desktop/),
    });
    const down = await engineRoadProbe({
      resolve: docker,
      sockets: [],
      run: run('{"Client":{"Version":"29"}}', 1),
    })();
    expect(down).toMatchObject({ status: 'fail', detail: expect.stringMatching(/^engine-down/) });
    const hung = await engineRoadProbe({
      resolve: docker,
      sockets: [],
      run: () => new Promise(() => undefined),
      setTimer: (fn) => {
        queueMicrotask(fn);
        return { cancel: () => undefined };
      },
    })();
    expect(hung).toMatchObject({ status: 'unknown', detail: expect.stringMatching(/timeout/) });
  });
});

describe('P90 release-resource through the real command path (read back before "released")', () => {
  it('tmpdir: applied with the read-back fact, dir gone, journal released → verified; again → already-released', async () => {
    const { task } = await openFresh();
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-release-'));
    temps.push(dir);
    const rid = addResource(task, 'tmpdir', dir);
    const got = await processCommand(task, release(task, rid), proof, commandEnv());
    expect(got).toMatchObject({ status: 'applied', outcome: { rid, verified: `${dir} absent` } });
    expect(existsSync(dir)).toBe(false);
    expect(task.state.resources[rid]).toEqual({ kind: 'tmpdir', status: 'verified' });
    expect(kinds(task).slice(-4)).toEqual([
      'command.received',
      'resource.released',
      'resource.verified',
      'command.applied',
    ]);
    const again = await processCommand(task, release(task, rid), proof, commandEnv());
    expect(again).toMatchObject({ status: 'rejected', code: 'already-released' });
    task.close();
  });
  it('unknown rid → no-such-resource; a lease → not-releasable (its own road); nothing released', async () => {
    const { task } = await openFresh();
    expect(await processCommand(task, release(task, newId()), proof, commandEnv())).toMatchObject({
      status: 'rejected',
      code: 'no-such-resource',
    });
    const lease = addResource(task, 'lease', '{"leaseId":"x"}');
    expect(await processCommand(task, release(task, lease), proof, commandEnv())).toMatchObject({
      status: 'rejected',
      code: 'not-releasable',
    });
    expect(kinds(task)).not.toContain('resource.released');
    task.close();
  });
  it('P40 stand: a real server process is stopped and its health address read back silent', async () => {
    const { task } = await openFresh();
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    children.push(child);
    const port = await new Promise<number>((done) =>
      child.stdout?.once('data', (b: Buffer) => done(Number(String(b).trim()))),
    );
    const health = `http://127.0.0.1:${port}/`;
    const id = await identityOfPid(child.pid as number);
    expect(id).toMatchObject({ value: { pid: child.pid } });
    if (!('value' in id)) return;
    const registry = createStandRegistry();
    const rid = attachStand(task, registry, { process: id.value, health, intervalMs: 60_000 });
    expect(await registry.get(task.taskId)?.tick()).toMatchObject({ healthy: true });
    expect(await registry.standEpoch(task.taskId)).toBe(0);
    const got = await processCommand(task, release(task, rid), proof, commandEnv());
    expect(got).toMatchObject({
      status: 'applied',
      outcome: { rid, verified: expect.stringMatching(/not answering$/) },
    });
    expect(await readHealth(health)).toMatchObject({ unknown: expect.any(String) });
    registry.detach(task.taskId);
    task.close();
  });
});

// ── настоящий движок ───────────────────────────────────────────────────────────────────────

const slack = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms * 6);
  return { cancel: () => clearTimeout(t) };
};
const engine = await engineHandle({ setTimer: slack });
const h: EngineHandle | undefined = 'value' in engine ? engine.value : undefined;
const pgImage = h ? await localImageOf(h, PG_CANDIDATES) : undefined;
const PG = pgImage ?? PG_CANDIDATES.join(' / ');
const havePg = pgImage !== undefined;
const inContainer = existsSync('/.dockerenv');

afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill();
  if (h) {
    const left = await listByLabels(h, { [EPHEMERAL_LABEL]: '1', [ZONE_LABEL]: ZONE_RUN });
    const ids = 'value' in left ? left.value.map((row) => row.id) : [];
    if (ids.length > 0) await runEngine(h, ['rm', '-f', '-v', ...ids], { timeoutMs: 120_000 });
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(h !== undefined)(
  'P44 container.by-label: an unread engine is retry, never "did not happen"',
  () => {
    it('container-start open after a crash, engine socket dead → decision retry with fact unknown', async () => {
      const { task } = await openFresh();
      const hint: ContainerHint = {
        labels: { 'agentdeck.task': task.taskId, 'agentdeck.service': 'db' },
        cli: 'docker',
        socket: deadSocket('reconcile'),
      };
      // Действие начато, эффекта и `action.done` нет: ядро умерло между fsync и запуском.
      task.append({
        kind: 'action.started',
        actor: 'core',
        data: {
          actionId: newId(),
          kind: 'container-start',
          target: 'db',
          idempotencyHint: JSON.stringify(hint),
        },
      });
      const decisions = await reconcileTask(task, actionReaders(), { now: Date.now }, new Map());
      expect(decisions).toMatchObject([
        { verdict: 'retry', fact: 'unknown', readClass: 'container.by-label' },
      ]);
      task.close();
    });
  },
);

// Причина пропуска — своей строкой: имя блока постоянное, по нему связан кейс блока тестов.
const p40Runs = h !== undefined && havePg && !inContainer;
function p40SkipReason(): string {
  if (!h) return `engine: ${'unknown' in engine ? engine.unknown : 'absent'}`;
  if (!havePg) return `no local ${PG}`;
  return 'published ports are on the engine host, not inside this container';
}
if (!p40Runs) it.skip(`P40/P90 skipped: ${p40SkipReason()}`, () => undefined);
describe.runIf(p40Runs)(
  'P40/P90 real postgres service of a task: started once, recorded, released at task end with read-back',
  { timeout: 240_000 },
  () => {
    it('ensureServices → endpoint + resource; repeat reuses; crash-open start reconciles by label; releaseServices verifies absence', async () => {
      const { task } = await openFresh(tempDir('svc-'));
      const recipe: ServiceRecipe = {
        name: 'db',
        source: 'compose',
        image: PG,
        ports: [5432],
        env: { POSTGRES_DB: 'app', POSTGRES_PASSWORD: 'pw-not-journaled' },
        scheme: 'postgres',
      };
      const ensure = createEnsureServices({
        task: () => task,
        recipes: () => [recipe],
        engine: async () => ({ value: h! }),
        start: { extraLabels: { [ZONE_LABEL]: ZONE_RUN }, readyTimeoutMs: 120_000 },
      });
      const first = await ensure(task.taskId, [{ service: 'db' }]);
      expect(first).toMatchObject({
        value: [
          {
            recipe: 'db',
            url: expect.stringMatching(
              /^postgres:\/\/postgres:pw-not-journaled@127\.0\.0\.1:\d+\/app$/,
            ),
          },
        ],
      });
      const second = await ensure(task.taskId, [{ service: 'db' }]);
      expect(second).toEqual(first);
      const lines = readJournalLines(task.dir, task.taskId).lines;
      const created = lines.filter(
        (l) => l.kind === 'resource.created',
      ) as JournalLine<'resource.created'>[];
      expect(created).toHaveLength(1);
      // Пароль рецепта в журнал не попал: в записи — движок, id, рецепт и порт.
      expect(JSON.stringify(lines)).not.toContain('pw-not-journaled');
      const ref = JSON.parse(created[0]!.data.ref) as {
        id: string;
        port: number;
        labels: Record<string, string>;
      };
      expect(ref.port).toBe(5432);
      expect(lines.filter((l) => l.kind === 'action.done')).toHaveLength(2);

      // Сверка после краха: начатый и не законченный запуск читается по меткам — «случилось».
      const hint: ContainerHint = { labels: ref.labels, cli: h!.info.cli, socket: h!.info.socket };
      task.append({
        kind: 'action.started',
        actor: 'core',
        data: {
          actionId: newId(),
          kind: 'container-start',
          target: 'db',
          idempotencyHint: JSON.stringify(hint),
        },
      });
      const decisions = await reconcileTask(task, actionReaders(), { now: Date.now }, new Map());
      expect(decisions.map((d) => d.verdict)).toEqual(['happened']);

      const released = await releaseServices(task);
      expect(released).toEqual([
        { rid: created[0]!.data.rid, verified: `container ${ref.id} absent` },
      ]);
      expect(await containerPresent(h!, ref.id)).toEqual({ value: false });
      expect(task.state.resources[created[0]!.data.rid]?.status).toBe('verified');
      // Повторный конец задачи снятое не трогает.
      expect(await releaseServices(task)).toEqual([]);
      task.close();
    });
  },
);
