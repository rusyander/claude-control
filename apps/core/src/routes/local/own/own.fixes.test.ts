import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  RouteDecisionRecord,
  RouteLease,
  RouteRecorder,
} from '@agentdeck/contracts/core/routes';
import type { GpuDevice } from '../../../platform/gpu.ts';
import { createLivenessProbe, type Liveness } from '../../../platform/process-identity.ts';
import { RouteAborted, RouteRefused } from '../../lease.ts';
import { createRouterClient } from './client.ts';
import { decideFit, pinDeviceEnv } from './fit.ts';
import { stopLeaseServers } from './__fixtures__/lease-sweep.ts';
import { ownDir, ownOptions, realStartToken } from './__fixtures__/own-options.ts';
import { createOwnRoute } from './own.ts';
import { presetIni } from './server.ts';
import { createSlotQueue } from './slot.ts';

/**
 * Исправления стадии 2 по `local:own` (core-s2: F-63, F-65, F-67, F-69, F-70, F-116, F-117 и
 * решение о сверке памяти чужой аренды): маршрут над подставными процессами (живость, память
 * карты) и настоящими, где путь идёт через ОС (запуск сервера, остановка дерева).
 */

const GIB = 1024 ** 3;
const base = mkdtempSync(join(tmpdir(), 'own-fixes-'));
afterAll(async () => {
  // Сервер аренды, брошенной красной проверкой, переживает vitest (хранитель) — снять первым.
  await stopLeaseServers(base);
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // Windows держит каталог хранителя ещё мгновение — временный каталог ОС уберёт сама.
  }
}, 120_000);

function rec(throwOn?: (kind: string) => boolean) {
  const events: string[] = [];
  const decisions: RouteDecisionRecord[] = [];
  const record: RouteRecorder = {
    decision: (d) => void decisions.push(d),
    created: () => undefined,
    verified: (_rid, fact) => {
      if (throwOn?.('verified')) throw new Error('journal write failed (test)');
      events.push(`verified:${fact}`);
    },
    leak: (_rid, reason) => {
      if (throwOn?.('leak')) throw new Error('journal write failed (test)');
      events.push(`leak:${reason}`);
    },
  };
  return { record, events, decisions };
}

const realProbe = createLivenessProbe();
/** Живость серверов прошлых ядер — подставная; о себе ядро читает настоящую таблицу. */
/** Ядро, записавшее аренды на диск, — прошлое и мёртвое (F-88: аренду живого ядра не принимают). */
const DEAD_CORE = { pid: 999_989, start: 'dead-core', bootId: 'previous-core' };
/** Старт сервера в записи аренды — токен настоящего вида (номер чужой: по личности мёртв). */
const SERVER_START = await realStartToken();

const probeOf = (state: Liveness, identityOf = realProbe.identityOf) => ({
  isAlive: async (id: { start: string }) => (id.start === DEAD_CORE.start ? 'dead' : state),
  identityOf,
  snapshot: async () => ({ unknown: 'probe: table unread' }),
});

const gpuOf = (devices: GpuDevice[] | (() => GpuDevice[])) => async () => ({
  value: {
    source: 'nvidia-smi' as const,
    unified: false,
    devices: typeof devices === 'function' ? devices() : devices,
  },
});

/**
 * Запись аренды прошлого, мёртвого ядра (`DEAD_CORE`): сервер — номер, которого нет (живость
 * сервера решает подставной пробник).
 */
function leaseOnDisk(
  workRoot: string,
  leaseId: string,
  extra: Record<string, unknown> = {},
  pid = 999_990,
): RouteLease {
  const dir = join(workRoot, leaseId);
  mkdirSync(dir, { recursive: true });
  const resources = [
    {
      rid: `${leaseId}-slot`,
      kind: 'model-slot' as const,
      ref: 'slot:gpu',
      release: 'task-end' as const,
    },
  ];
  writeFileSync(
    join(dir, 'lease.json'),
    JSON.stringify({
      v: 1,
      leaseId,
      routeId: 'local:own',
      model: 'tiny-model',
      dialect: 'openai-chat',
      slotKey: 'gpu',
      resources,
      baselineUsedBytes: GIB,
      server: {
        identity: { pid, start: SERVER_START },
        origin: 'http://127.0.0.1:9',
        port: 9,
        marker: `own-fixes-${leaseId}-${process.pid}`,
      },
      owner: DEAD_CORE,
      ...extra,
    }),
  );
  return { leaseId, routeId: 'local:own', model: 'tiny-model', resources };
}

const dummy: RouteLease = {
  leaseId: 'nope',
  routeId: 'local:own',
  model: 'tiny-model',
  resources: [],
};
const within = <T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> =>
  Promise.race([p, new Promise<'TIMEOUT'>((done) => setTimeout(() => done('TIMEOUT'), ms))]);
const until = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await new Promise((d) => setTimeout(d, 25));
  return check();
};

describe('core-s2 local:own restore — never wedged, never silent (F-67, F-116)', () => {
  it('F-67 local:own: two lease records of live servers on one slot → restore resolves at once, both hold the slot, one journaled human point; the slot frees after both release', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'two-')));
    const first = leaseOnDisk(layout.workRoot, 'L1', {}, 999_991);
    const second = leaseOnDisk(layout.workRoot, 'L2', {}, 999_992);
    const slots = createSlotQueue();
    const journal = rec();
    const route = createOwnRoute({
      ...ownOptions(layout),
      slots,
      probe: probeOf('alive'),
      journal: journal.record,
      recheckMs: 50,
    });
    expect(await within(route.release(dummy, rec().record), 10_000)).not.toBe('TIMEOUT');
    expect(slots.held('gpu')).toBe(true);
    const points = journal.decisions.filter((d) => d.humanPoint);
    expect(points).toHaveLength(1);
    expect(points[0]?.humanPoint?.subject).toMatch(/lease L1.*lease L2|lease L2.*lease L1/);
    const r = rec();
    await route.release(first, r.record);
    expect(slots.held('gpu')).toBe(true);
    await route.release(second, r.record);
    expect(slots.held('gpu')).toBe(false);
  }, 60_000);

  it('F-67 local:own: the same two records with liveness unknown → restore resolves, the slot stays held', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'two-unknown-')));
    leaseOnDisk(layout.workRoot, 'L1', {}, 999_991);
    leaseOnDisk(layout.workRoot, 'L2', {}, 999_992);
    const slots = createSlotQueue();
    const route = createOwnRoute({
      ...ownOptions(layout),
      slots,
      probe: probeOf('unknown'),
      recheckMs: 200,
      livenessRetryMs: 1_000,
    });
    expect(await within(route.release(dummy, rec().record), 10_000)).not.toBe('TIMEOUT');
    expect(slots.held('gpu')).toBe(true);
    await route.shutdown(rec().record);
  }, 60_000);

  it('F-116 local:own: server liveness unknown with livenessRetryMs 0 → the waiting task gets a human point (never a silent hold)', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'retry0-')));
    leaseOnDisk(layout.workRoot, 'L1');
    const slots = createSlotQueue();
    const route = createOwnRoute({
      ...ownOptions(layout),
      slots,
      probe: probeOf('unknown'),
      livenessRetryMs: 0,
      recheckMs: 50,
    });
    const waiter = rec();
    const controller = new AbortController();
    const waiting = route
      .acquire({ taskId: 'w', model: 'tiny-model', signal: controller.signal }, waiter.record)
      .then(
        () => 'granted',
        (error: unknown) => error,
      );
    const told = await until(() => waiter.decisions.some((d) => d.humanPoint), 5_000);
    controller.abort();
    expect(await waiting).toBeInstanceOf(RouteAborted);
    expect(told).toBe(true);
    expect(waiter.decisions.find((d) => d.humanPoint)?.humanPoint?.subject).toMatch(/lease L1/);
    await route.shutdown(rec().record);
  }, 60_000);

  it('F-116 local:own: a restore that threw once is not memoised — the next call restores', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'memo-')));
    let calls = 0;
    const route = createOwnRoute({
      ...ownOptions(layout),
      slots: createSlotQueue(),
      probe: probeOf('dead', async (pid) => {
        calls += 1;
        if (calls === 1) throw new Error('process table read threw (test)');
        return realProbe.identityOf(pid);
      }),
    });
    await expect(route.release(dummy, rec().record)).rejects.toThrow(/threw \(test\)/);
    expect(await route.release(dummy, rec().record)).toEqual({ verified: [], leaks: [] });
  }, 30_000);
});

describe('core-s2 local:own acquire and release edges (F-63, F-65, F-69, F-70)', () => {
  it('F-70 local:own: a model whose file is gone is refused model_absent before the slot is taken', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'nofile-')));
    rmSync(layout.modelPath);
    const slots = createSlotQueue();
    const route = createOwnRoute({ ...ownOptions(layout), slots });
    const got: unknown = await route
      .acquire({ taskId: 't', model: 'tiny-model' }, rec().record)
      .then(
        (lease) => lease,
        (error: unknown) => error,
      );
    // Красный путь (выдача без проверки): снять поднятый сервер, прежде чем упасть.
    if (!(got instanceof Error)) await route.release(got as RouteLease, rec().record);
    expect(got).toBeInstanceOf(RouteRefused);
    expect((got as RouteRefused).code).toBe('model_absent');
    expect(slots.held('gpu')).toBe(false);
  }, 60_000);

  it('local:own availability: a relative server path found from the core cwd is not startable — the server starts in a fresh lease dir where it never resolves', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'relcmd-')));
    // Путь существует от cwd процесса тестов, но не от каталога аренды, где сервер запускается.
    const command = relative(process.cwd(), process.execPath);
    expect(isAbsolute(command)).toBe(false);
    const options = ownOptions(layout);
    const route = createOwnRoute({ ...options, server: { ...options.server, command } });
    expect(await route.read.availability()).toEqual({ absent: true });
    const bare = createOwnRoute(options);
    expect(await bare.read.availability()).toEqual({ value: { state: 'startable' } });
  });

  it('F-63 local:own: a journal write that throws mid-release does not leave the slot held when nothing was started', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'throw-')));
    const slots = createSlotQueue();
    const route = createOwnRoute({
      ...ownOptions(layout),
      slots,
      gpu: gpuOf([{ id: '0', totalBytes: 2 * GIB, usedBytes: 2 * GIB, freeBytes: 0 }]),
    });
    const r = rec((kind) => kind === 'verified');
    await expect(route.acquire({ taskId: 't', model: 'tiny-model' }, r.record)).rejects.toThrow(
      /journal write failed/,
    );
    expect(slots.held('gpu')).toBe(false);
  }, 30_000);

  it('F-63 local:own: a throw before the server is proven stopped keeps the slot and the lease; the next release finishes the protocol', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'throw-held-')));
    const lease = leaseOnDisk(layout.workRoot, 'L1');
    // Порядок заведения: слот → сервер → загрузка; освобождение — обратный (выгрузка до остановки).
    lease.resources.push({
      rid: 'L1-server',
      kind: 'model-server',
      ref: `pid 999990 start ${SERVER_START} http://127.0.0.1:9`,
      release: 'task-end',
    });
    lease.resources.push({
      rid: 'L1-load',
      kind: 'model-load',
      ref: 'tiny-model@http://127.0.0.1:9',
      release: 'task-end',
    });
    const slots = createSlotQueue();
    const route = createOwnRoute({
      ...ownOptions(layout),
      slots,
      probe: probeOf('alive'),
      unloadTimeoutMs: 500,
    });
    await expect(route.release(lease, rec((kind) => kind === 'leak').record)).rejects.toThrow(
      /journal write failed/,
    );
    expect(slots.held('gpu')).toBe(true);
    const r = rec();
    const done = await route.release(lease, r.record);
    expect(done.leaks.map((l) => l.rid)).toEqual(['L1-load']);
    expect(r.events[1]).toMatch(/^verified:tree stopped: 0 processes/);
    expect(slots.held('gpu')).toBe(false);
  }, 60_000);

  it('F-65 local:own: a task cancelled while the server is not yet healthy → acquire rejects RouteAborted at once (not after startTimeoutMs), slot free', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'abort-start-')));
    const slots = createSlotQueue();
    const route = createOwnRoute({
      ...ownOptions(layout),
      server: { command: process.execPath, leadArgs: ['-e', 'setInterval(() => {}, 1000)', '--'] },
      slots,
      startTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const started = Date.now();
    const pending = route
      .acquire({ taskId: 't', model: 'tiny-model', signal: controller.signal }, rec().record)
      .then(
        () => 'granted',
        (error: unknown) => error,
      );
    setTimeout(() => controller.abort(), 1_500);
    const got = await within(pending, 20_000);
    expect(got).toBeInstanceOf(RouteAborted);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(slots.held('gpu')).toBe(false);
  }, 90_000);

  it('F-65 local:own client: load polls stop on abort — RouteAborted, not the load timeout', async () => {
    const fetchImpl = (async (url: string) => {
      const body = String(url).endsWith('/models')
        ? { data: [{ id: 'm', status: { value: 'loading' } }] }
        : { success: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRouterClient('http://127.0.0.1:9', { fetchImpl, pollMs: 20 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const got = await client.load('m', 5_000, controller.signal).then(
      () => 'loaded',
      (error: unknown) => error,
    );
    expect(got).toBeInstanceOf(RouteAborted);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('F-69 local:own: on two cards the server starts pinned to the card the fit chose (CUDA order by PCI bus); user env wins', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'pin-')));
    const out = join(layout.dir, 'env.txt');
    const script =
      "require('fs').appendFileSync(process.env.ENV_OUT, [process.env.CUDA_VISIBLE_DEVICES, process.env.CUDA_DEVICE_ORDER].join(' ') + '\\n'); process.exit(2)";
    const route = createOwnRoute({
      ...ownOptions(layout),
      server: { command: process.execPath, leadArgs: ['-e', script, '--'], env: { ENV_OUT: out } },
      slots: createSlotQueue(),
      gpu: gpuOf([
        { id: '0', totalBytes: 4 * GIB, usedBytes: 3 * GIB, freeBytes: 1 * GIB },
        { id: '1', totalBytes: 8 * GIB, usedBytes: 2 * GIB, freeBytes: 6 * GIB },
      ]),
    });
    await expect(route.acquire({ taskId: 't', model: 'tiny-model' }, rec().record)).rejects.toThrow(
      /failed to start/,
    );
    expect(readFileSync(out, 'utf8').trim().split('\n')[0]).toBe('1 PCI_BUS_ID');

    const two = gpuOf([
      { id: '0', totalBytes: 4 * GIB, usedBytes: 3 * GIB, freeBytes: 1 * GIB },
      { id: '1', totalBytes: 8 * GIB, usedBytes: 2 * GIB, freeBytes: 6 * GIB },
    ]);
    const memory = await two();
    const fit = decideFit({
      model: { id: 'm', sizeBytes: GIB },
      gpu: memory,
      ram: { totalBytes: 0, freeBytes: 0 },
      overheadBytes: GIB,
    });
    expect(pinDeviceEnv(fit, memory, { CUDA_VISIBLE_DEVICES: '0' })).toEqual({
      CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
    });
    const one = await gpuOf([{ id: '0', totalBytes: 8 * GIB, usedBytes: 0, freeBytes: 8 * GIB }])();
    expect(
      pinDeviceEnv(
        decideFit({
          model: { id: 'm', sizeBytes: GIB },
          gpu: one,
          ram: { totalBytes: 0, freeBytes: 0 },
          overheadBytes: GIB,
        }),
        one,
      ),
    ).toEqual({});
  }, 90_000);
});

describe('core-s2 local:own card memory read-back (F-117, decision: per-lease attribution)', () => {
  it('F-117 local:own: an orphan on one card is not hidden by memory freed on another — read-back per card', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'per-card-')));
    const lease = leaseOnDisk(layout.workRoot, 'L1', {
      baselineUsedBytes: 3 * GIB,
      baselineDevices: { '0': GIB, '1': 2 * GIB },
    });
    const route = createOwnRoute({
      ...ownOptions(layout),
      slots: createSlotQueue(),
      probe: probeOf('dead'),
      settleMs: 300,
      gpu: gpuOf([
        { id: '0', totalBytes: 8 * GIB, usedBytes: 3 * GIB, freeBytes: 5 * GIB },
        { id: '1', totalBytes: 8 * GIB, usedBytes: 0, freeBytes: 8 * GIB },
      ]),
    });
    const done = await route.release(lease, rec().record);
    expect(done.leaks).toEqual([
      {
        rid: 'L1-slot',
        reason: expect.stringMatching(
          /^vram not back: .*device 0 used 3\.00 GiB vs baseline 1\.00 GiB/,
        ),
      },
    ]);
  }, 60_000);

  it('decision local:own: a lease whose server was dead at restore, released while another lease holds the slot → no «vram not back» for the other lease’s model; with the slot free the read-back still runs', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'attrib-')));
    const first = leaseOnDisk(layout.workRoot, 'L1');
    const second = leaseOnDisk(layout.workRoot, 'L2');
    const slots = createSlotQueue();
    // Карта: база 1 GiB + 3 GiB модели аренды, держащей слот сейчас.
    const route = createOwnRoute({
      ...ownOptions(layout),
      slots,
      probe: probeOf('dead'),
      settleMs: 300,
      gpu: gpuOf([{ id: '0', totalBytes: 8 * GIB, usedBytes: 4 * GIB, freeBytes: 4 * GIB }]),
    });
    await route.release(dummy, rec().record);
    expect(slots.held('gpu')).toBe(false);
    const other = await slots.acquire('gpu');
    const attributed = await route.release(first, rec().record);
    expect(attributed.leaks).toEqual([]);
    expect(attributed.verified.find((v) => v.rid === 'L1-slot')?.fact).toMatch(
      /^slot returned at restore: model server dead by identity; vram read-back not attributable: slot gpu now held by another lease$/,
    );
    other.release();
    const unattributed = await route.release(second, rec().record);
    expect(unattributed.leaks).toEqual([
      {
        rid: 'L2-slot',
        reason: expect.stringMatching(/^vram not back: used 4\.00 GiB vs baseline 1\.00 GiB/),
      },
    ]);
  }, 60_000);

  it('F-117 local:own preset: an INI comment character in the model id or path is refused, never truncated', () => {
    expect(() => presetIni([{ id: 'm', path: 'C:\\models\\a;b.gguf' }])).toThrow(/INI comment/);
    expect(() => presetIni([{ id: 'm#1', path: '/m.gguf' }])).toThrow(/INI comment/);
    expect(presetIni([{ id: 'm', path: '/m.gguf' }])).toBe('[m]\nmodel = /m.gguf\n');
  });
});
