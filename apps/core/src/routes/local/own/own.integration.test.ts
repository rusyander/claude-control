import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { RouteRecorder, RouteResource } from '@agentdeck/contracts/core/routes';
import type { GpuMemory } from '../../../platform/gpu.ts';
import type { Fact } from '../../../platform/os-kind.ts';
import { RouteAborted, RouteRefused } from '../../lease.ts';
import { createOwnRoute, type OwnRouteOptions } from './own.ts';
import { createSlotQueue } from './slot.ts';
import {
  alive,
  BASE_USED,
  fakeGpu,
  GIB,
  identityNow,
  liveRunnerFiles,
  livenessNow,
  readRunners,
  RUNNER_BYTES,
  TOTAL,
  type RunnerFile,
} from './__fixtures__/fake-gpu.ts';
import { stopLeaseServers } from './__fixtures__/lease-sweep.ts';

/**
 * Протокол своего сервера моделей (11 R:PR-04) на НАСТОЯЩИХ процессах: подставной маршрутизатор
 * (`__fixtures__/fake-router.mjs`) рождает раннеров-потомков, раннер отвечает общей заглушкой
 * stub-llama и «занимает память карты». Подставная память = базовое занятое + байты ЖИВЫХ
 * раннеров: сирота, переживший остановку, держит память так же, как у владельца 12.09.
 */

const ROUTER = fileURLToPath(new URL('./__fixtures__/fake-router.mjs', import.meta.url));

const root = mkdtempSync(join(tmpdir(), 'own-route-'));
/** Каталоги памяти наборов: по ним уборка находит раннеров, переживших проверку. */
const vramDirs: string[] = [];

function harness(name: string, mode = 'normal', extra: Partial<OwnRouteOptions> = {}) {
  const dir = mkdtempSync(join(root, `${name}-`));
  const vramDir = join(dir, 'vram');
  const workRoot = join(dir, 'leases');
  mkdirSync(vramDir);
  writeFileSync(join(dir, 'model.gguf'), 'GGUF fake model bytes');
  const runners = (): RunnerFile[] => readRunners(vramDir);
  /** Живые раннеры по личности: номер снятого раннера Windows отдаёт другому процессу за секунды. */
  const liveRunners = (): Promise<RunnerFile[]> => liveRunnerFiles(vramDir);
  /** Управляющие вызовы, которые получил подставной маршрутизатор (`/models/load tiny-model`). */
  const calls = (): string[] => {
    const log = join(vramDir, 'router-calls.log');
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  };
  // Общая подставная память (раннеры по личности, полный прогон 28.10: своя копия по номеру
  // читала чужой процесс раннером — «vram not back: used 3.00 GiB»).
  const gpu: () => Promise<Fact<GpuMemory>> = fakeGpu(vramDir);
  vramDirs.push(vramDir);
  const events: string[] = [];
  const resources: RouteResource[] = [];
  const decisions: unknown[] = [];
  const record: RouteRecorder = {
    decision: (d) => {
      events.push(`decision:${d.class}`);
      decisions.push(d);
    },
    created: (r) => {
      events.push(`created:${r.kind}`);
      resources.push(r);
    },
    verified: (rid, fact) => {
      events.push(`verified:${resources.find((r) => r.rid === rid)?.kind}:${fact}`);
    },
    leak: (rid, reason) => {
      events.push(`leak:${resources.find((r) => r.rid === rid)?.kind}:${reason}`);
    },
  };
  const route = createOwnRoute({
    server: {
      command: process.execPath,
      leadArgs: [ROUTER],
      env: {
        FAKE_VRAM_DIR: vramDir,
        FAKE_ROUTER_MODE: mode,
        FAKE_VRAM_BYTES: String(RUNNER_BYTES),
      },
    },
    models: [
      { id: 'tiny-model', path: join(dir, 'model.gguf'), sizeBytes: 1 * GIB, contextTokens: 4096 },
    ],
    workRoot,
    gpu,
    ram: () => ({ totalBytes: 32 * GIB, freeBytes: 16 * GIB }),
    slots: createSlotQueue(),
    settleMs: 2_000,
    loadTimeoutMs: 15_000,
    ...extra,
  });
  return { route, record, events, resources, decisions, gpu, runners, liveRunners, calls };
}

afterAll(async () => {
  // Сервер аренды, брошенной красной проверкой, переживает vitest (хранитель) — снять первым.
  await stopLeaseServers(root);
  // Сироты режима `orphan-runner` (и всё, что тест мог оставить) — снимаются здесь. По личности:
  // номер давно снятого раннера мог достаться чужому процессу — его не трогать.
  for (const dir of vramDirs) for (const r of await liveRunnerFiles(dir)) process.kill(r.pid);
}, 120_000);

describe('local:own route protocol over a fake router with runner children', () => {
  it('R:PR-04 acquire → fit decision before load → chat through the router → release: unload, tree stop, VRAM back → verified', async () => {
    const h = harness('happy');
    const lease = await h.route.acquire({ taskId: 't1', model: 'tiny-model' }, h.record);
    expect(h.events).toEqual([
      'created:model-slot',
      'decision:fit',
      'created:tmpdir',
      'created:model-server',
      'created:model-load',
    ]);
    expect(h.decisions[0]).toMatchObject({
      class: 'fit',
      facts: [{ readClass: 'gpu.memory', kind: 'value' }],
      numbers: {
        sizeBytes: GIB,
        needBytes: 2 * GIB,
        freeBytes: TOTAL - BASE_USED,
        baselineUsedBytes: BASE_USED,
      },
      output: { kind: 'fits', basis: 'measured', device: '0' },
    });
    const endpoint = await h.route.endpoint(lease, h.record);
    expect(endpoint).toMatchObject({ dialect: 'openai-chat', keyRef: null });
    expect(endpoint?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const reply = await fetch(`${endpoint?.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tiny-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(reply.status).toBe(200);
    expect(JSON.stringify(await reply.json())).toContain('function merge()');
    const loaded = await h.gpu();
    expect('value' in loaded && loaded.value.devices[0]?.usedBytes).toBe(BASE_USED + RUNNER_BYTES);
    expect(await h.route.read.availability()).toEqual({ value: { state: 'up' } });

    const runners = await Promise.all(h.runners().map((r) => identityNow(r.pid)));
    h.events.length = 0;
    const outcome = await h.route.release(lease, h.record);
    expect(outcome.leaks).toEqual([]);
    expect(h.events).toEqual([
      'verified:model-load:server lists no loaded model (1 listed)',
      expect.stringMatching(
        /^verified:model-server:tree stopped: [1-9]\d* processes .*none alive$/,
      ),
      'verified:tmpdir:lease dir removed',
      expect.stringMatching(/^verified:model-slot:vram back: used 1\.00 GiB vs baseline 1\.00 GiB/),
    ]);
    expect(runners.length).toBe(1);
    // По личности: номер остановленного раннера Windows мог уже отдать другому процессу.
    expect(await Promise.all(runners.map(livenessNow))).toEqual(['dead']);
    // Выгрузку маршрут именно ПРОСИЛ — до остановки дерева, а не полагался на неё.
    expect(h.calls()).toEqual(['/models/load tiny-model', '/models/unload tiny-model']);
  }, 60_000);

  it('R:PR-04 VRAM short → fit decision `short`, refusal route_unavailable, no server started, slot returned', async () => {
    const h = harness('short', 'normal', { overheadBytes: 7 * GIB });
    const refusal = await h.route
      .acquire({ taskId: 't2', model: 'tiny-model' }, h.record)
      .catch((e) => e);
    expect(refusal).toBeInstanceOf(RouteRefused);
    expect(refusal).toMatchObject({ code: 'route_unavailable' });
    expect((refusal as RouteRefused).reason).toMatch(/short by 1\.00 GiB/);
    expect(h.decisions[0]).toMatchObject({
      output: { kind: 'short', needBytes: 8 * GIB, freeBytes: 7 * GIB },
    });
    expect(h.events).toEqual([
      'created:model-slot',
      'decision:fit',
      'verified:model-slot:slot returned: nothing was loaded',
    ]);
    expect(h.runners()).toEqual([]);
    // Слот свободен: следующая аренда не ждёт.
    const lease2 = await h.route
      .acquire({ taskId: 't2', model: 'other' }, h.record)
      .catch((e) => e);
    expect(lease2).toMatchObject({ code: 'model_absent' });
  }, 30_000);

  it('R:PR-04 one model per GPU: a second acquire waits for the slot (never evicts), abort leaves the queue', async () => {
    const slots = createSlotQueue();
    const h = harness('slot', 'normal', { slots });
    const first = await h.route.acquire({ taskId: 'a', model: 'tiny-model' }, h.record);
    const controller = new AbortController();
    const second = h.route.acquire(
      { taskId: 'b', model: 'tiny-model', signal: controller.signal },
      h.record,
    );
    await new Promise((done) => setTimeout(done, 300));
    expect(slots.waiting('gpu')).toBe(1);
    expect(h.runners().length).toBe(1);
    controller.abort();
    await expect(second).rejects.toBeInstanceOf(RouteAborted);
    expect(slots.waiting('gpu')).toBe(0);

    const third = h.route.acquire({ taskId: 'c', model: 'tiny-model' }, h.record);
    await new Promise((done) => setTimeout(done, 300));
    expect(slots.waiting('gpu')).toBe(1);
    await h.route.release(first, h.record);
    const lease3 = await third;
    expect(await h.liveRunners()).toHaveLength(1);
    expect((await h.route.release(lease3, h.record)).leaks).toEqual([]);
    expect(slots.held('gpu')).toBe(false);
  }, 90_000);

  it('R:PR-04 orphaned runner keeps VRAM → tree stop verified but VRAM read-back → resource.leak, shown', async () => {
    const h = harness('orphan', 'orphan-runner');
    const lease = await h.route.acquire({ taskId: 't4', model: 'tiny-model' }, h.record);
    const orphan = h.runners()[0]?.pid ?? 0;
    expect(alive(orphan)).toBe(true);
    h.events.length = 0;
    const outcome = await h.route.release(lease, h.record);
    expect(outcome.leaks).toContainEqual({
      rid: expect.any(String),
      reason: expect.stringMatching(/^vram not back: used 3\.00 GiB vs baseline 1\.00 GiB/),
    });
    expect(h.events[0]).toMatch(/^verified:model-load:/);
    expect(h.events[1]).toMatch(/^verified:model-server:tree stopped/);
    // Сирота держит и cwd: на Windows каталог аренды занят (EBUSY) — тоже утечка, названная.
    expect(h.events[2]).toMatch(/^(verified:tmpdir:lease dir removed|leak:tmpdir:.*EBUSY)/);
    expect(h.events[3]).toMatch(/^leak:model-slot:vram not back/);
    expect(alive(orphan)).toBe(true);
    process.kill(orphan);
  }, 60_000);

  it('R:PR-04 load failure → acquire throws, everything created is released by the same protocol, slot free', async () => {
    const slots = createSlotQueue();
    const h = harness('fail', 'fail-load', { slots });
    const error = await h.route
      .acquire({ taskId: 't5', model: 'tiny-model' }, h.record)
      .catch((e) => e);
    expect(String(error)).toMatch(/failed to load tiny-model \(exit 3\)/);
    expect(h.events.filter((e) => e.startsWith('verified:') || e.startsWith('leak:'))).toEqual([
      'verified:model-load:server lists no loaded model (1 listed)',
      expect.stringMatching(/^verified:model-server:tree stopped/),
      'verified:tmpdir:lease dir removed',
      expect.stringMatching(/^verified:model-slot:vram back/),
    ]);
    expect(slots.held('gpu')).toBe(false);
    // Слот свободен на деле: следующий запрос той же очереди его получает; застрявший слот —
    // ожидание до отмены, RouteAborted.
    const next = harness('fail-next', 'normal', { slots });
    const stuck = new AbortController();
    const timer = setTimeout(() => stuck.abort(), 20_000);
    const lease = await next.route
      .acquire({ taskId: 't5b', model: 'tiny-model', signal: stuck.signal }, next.record)
      .finally(() => clearTimeout(timer));
    expect(slots.held('gpu')).toBe(true);
    expect((await next.route.release(lease, next.record)).leaks).toEqual([]);
    expect(slots.held('gpu')).toBe(false);
  }, 60_000);
});

describe('local:own edges — facts, unreadable GPU, start failures, foreign lease', () => {
  it('R:PR-03 local:own facts: startable by binary on PATH, absent without it; models only with their file; slot limit, gpu-time price, no credential', async () => {
    const h = harness('facts');
    expect(h.route).toMatchObject({ kind: 'local', id: 'local:own' });
    expect(await h.route.read.availability()).toEqual({ value: { state: 'startable' } });
    expect(await h.route.read.models()).toEqual({
      value: [{ id: 'tiny-model', sizeBytes: GIB, contextTokens: 4096 }],
    });
    expect(await h.route.read.limit()).toEqual({ value: { kind: 'slot', slots: 1 } });
    expect(await h.route.read.price('tiny-model')).toEqual({ value: { unit: 'gpu-time' } });
    expect(await h.route.read.credential()).toEqual({ value: { kind: 'none', present: true } });
    expect(await h.route.read.context('tiny-model')).toEqual({ value: 4096 });
    expect(await h.route.read.context('other')).toEqual({ absent: true });
    const missing = harness('facts-missing', 'normal', {
      server: { command: 'no-such-model-server-binary' },
      models: [{ id: 'gone', path: join(root, 'gone.gguf'), sizeBytes: 1, tools: false }],
    });
    expect(await missing.route.read.availability()).toEqual({ absent: true });
    expect(await missing.route.read.models()).toEqual({ value: [] });
    // Файла модели нет — отказ model_absent до слота (core-s2 F-70): ни ресурса, ни решения.
    const absent = await missing.route
      .acquire({ taskId: 't', model: 'gone' }, missing.record)
      .catch((e) => e);
    expect(absent).toBeInstanceOf(RouteRefused);
    expect((absent as RouteRefused).code).toBe('model_absent');
    expect(missing.events).toEqual([]);
    // Файл появился, бинарника нет — запуск падает, слот и каталог возвращены.
    writeFileSync(join(root, 'gone.gguf'), 'x');
    const err = await missing.route
      .acquire({ taskId: 't', model: 'gone' }, missing.record)
      .catch((e) => e);
    expect(String(err)).toMatch(
      /model server did not start: «no-such-model-server-binary» not found/,
    );
    expect(missing.events).toEqual([
      'created:model-slot',
      'decision:fit',
      'created:tmpdir',
      'verified:tmpdir:lease dir removed',
      'verified:model-slot:slot returned: nothing was loaded',
    ]);
  }, 30_000);

  it('R:PR-04 GPU memory unreadable → fit by estimate, named; release cannot prove VRAM back → resource.leak', async () => {
    const h = harness('estimate', 'normal', {
      gpu: async () => ({ unknown: 'nvidia-smi: ENOENT' }),
    });
    const lease = await h.route.acquire({ taskId: 't', model: 'tiny-model' }, h.record);
    expect(h.decisions[0]).toMatchObject({
      facts: [{ readClass: 'gpu.memory', kind: 'unknown' }],
      output: { kind: 'fits', basis: 'estimate' },
    });
    const outcome = await h.route.release(lease, h.record);
    expect(outcome.leaks.map((l) => l.reason)).toEqual([
      'vram read-back impossible: no baseline before load',
    ]);
  }, 60_000);

  it('R:PR-04 server exits at start → retried on new ports, then refused; nothing left, slot free', async () => {
    const slots = createSlotQueue();
    const h = harness('early-exit', 'normal', {
      slots,
      server: { command: process.execPath, leadArgs: ['-e', 'process.exit(2)', '--'] },
    });
    const err = await h.route
      .acquire({ taskId: 't', model: 'tiny-model' }, h.record)
      .catch((e) => e);
    expect(String(err)).toMatch(
      /model server failed to start: (port \d+: exited early \(code 2, signal -\)(; )?){3}$/,
    );
    expect(h.events.some((e) => e.startsWith('created:model-server'))).toBe(false);
    expect(slots.held('gpu')).toBe(false);
  }, 60_000);

  it('R:PR-04 release of a lease this route does not hold → every resource named as leak; endpoint refuses it', async () => {
    const h = harness('foreign');
    const lease = {
      leaseId: 'x',
      routeId: 'local:own',
      model: 'tiny-model',
      resources: [
        { rid: 'r1', kind: 'model-server' as const, ref: 'pid 1', release: 'task-end' as const },
      ],
    };
    // Сервера этой аренды маршрут не знает — адреса нет, решение `endpoint` (F-73).
    expect(await h.route.endpoint(lease, h.record)).toBeNull();
    const outcome = await h.route.release(lease, h.record);
    expect(outcome.leaks).toEqual([
      { rid: 'r1', reason: 'lease x is not held by local:own (core restarted?)' },
    ]);
  });
});
