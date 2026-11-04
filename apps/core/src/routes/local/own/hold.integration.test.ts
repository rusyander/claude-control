import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LocalHoldBody } from '@agentdeck/contracts/core/local-hold';
import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { allocatePort } from '../../../platform/ports.ts';
import { startLocalFront, type LocalFront } from './front.ts';
import { createLocalHold, HOLD_ROUTE_ID, type LocalHold } from './hold.ts';
import { readLeaseState } from './lease-state.ts';
import { createOwnRoute } from './own.ts';
import { attachRouter, stopRouter } from './server.ts';
import { createSlotQueue, type SlotQueue } from './slot.ts';
import { BASE_USED, fakeGpu, GIB, liveRunnerFiles } from './__fixtures__/fake-gpu.ts';
import { stopLeaseServers } from './__fixtures__/lease-sweep.ts';
import { ownDir, ownOptions, ROUTER, type OwnDir } from './__fixtures__/own-options.ts';

/**
 * Удержание своей модели панелью (этап 10, зона C) на НАСТОЯЩИХ процессах: подставной
 * маршрутизатор рождает раннера, раннер отвечает заглушкой `packages/stub-model` и «держит память
 * карты». Кнопка панели — это `hold`/`release` маршрута `local:own`: слот общий с задачами ядра,
 * адрес для CLI — постоянный порт ядра, а не порт сервера аренды.
 */

const root = mkdtempSync(join(tmpdir(), 'local-hold-'));
const leaseRoots: string[] = [];
const fronts: LocalFront[] = [];

const silent: RouteRecorder = {
  decision: () => undefined,
  created: () => undefined,
  verified: () => undefined,
  leak: () => undefined,
};

interface Kit {
  layout: OwnDir;
  workRoot: string;
  slots: SlotQueue;
  hold: LocalHold;
  body: LocalHoldBody;
}

function kit(
  name: string,
  slots: SlotQueue = createSlotQueue(),
  workRoot?: string,
  liveCacheMs?: number,
): Kit {
  const layout = ownDir(mkdtempSync(join(root, `${name}-`)));
  const own = ownOptions(layout);
  const holdRoot = workRoot ?? join(layout.dir, 'hold');
  leaseRoots.push(join(holdRoot, 'leases'), layout.workRoot);
  const hold = createLocalHold({
    workRoot: holdRoot,
    journal: silent,
    leadArgs: [ROUTER],
    route: {
      slots,
      gpu: fakeGpu(layout.vramDir),
      ram: () => ({ totalBytes: 32 * GIB, freeBytes: 16 * GIB }),
      settleMs: 2_000,
      loadTimeoutMs: 15_000,
    },
    reviveBackoffMs: 10,
    ...(liveCacheMs === undefined ? {} : { liveCacheMs }),
  });
  const body: LocalHoldBody = {
    server: { command: process.execPath, env: own.server.env ?? {} },
    model: {
      id: 'tiny-model',
      path: layout.modelPath,
      sizeBytes: 1 * GIB,
      // Окно шире запаса под ответ (4096): у окна 4096 фронт отказал бы любому промпту.
      contextTokens: 16384,
      args: { 'ctx-size': '16384', 'cache-type-k': 'q8_0' },
    },
    meta: { quant: 'Q4_K_M' },
  };
  return { layout, workRoot: holdRoot, slots, hold, body };
}

async function front(hold: LocalHold, port?: number, retryMs = 100): Promise<LocalFront> {
  const started = startLocalFront({
    port: port ?? (await allocatePort()).port,
    target: (stale) => hold.target(stale),
    retryMs,
  });
  fronts.push(started);
  return started;
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

async function chat(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'tiny-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: response.status, text: await response.text() };
}

afterAll(async () => {
  await Promise.all(fronts.map((f) => f.stop()));
  for (const dir of leaseRoots) await stopLeaseServers(dir);
}, 60_000);

describe('local hold — the panel button over local:own', () => {
  it('hold loads the model behind the stable port; release unloads it and VRAM is read back', async () => {
    const k = kit('hold');
    const f = await front(k.hold);
    expect(await until(() => f.listening())).toBe(true);
    // Ничего не удержано — постоянный адрес отвечает отказом с причиной, а не тишиной.
    const before = await chat(f.url);
    expect(before.status).toBe(503);
    expect(before.text).toContain('local_not_held');
    // Проба здоровья — 404, не 503: 503 у llama-server значит «грузится», панель ждала бы зря.
    expect((await fetch(`${f.url}/health`)).status).toBe(404);

    const held = await k.hold.hold(k.body);
    expect(held.ok).toBe(true);
    const view = await k.hold.view(null);
    expect(view.live).toBe(true);
    expect(view.held?.model).toBe('tiny-model');
    expect(view.held?.meta).toEqual({ quant: 'Q4_K_M' });
    // Порт сервера аренды — другой, CLI ходит на постоянный.
    expect(view.held?.origin).not.toBe(f.url);
    expect(await liveRunnerFiles(k.layout.vramDir)).toHaveLength(1);
    const through = await chat(f.url);
    expect(through.status).toBe(200);
    expect(through.text).toContain('function merge');

    // Та же модель с тем же запуском — второй загрузки нет.
    expect((await k.hold.hold(k.body)).ok).toBe(true);
    expect(await liveRunnerFiles(k.layout.vramDir)).toHaveLength(1);

    const released = await k.hold.release();
    expect(released.released).toBe(true);
    expect(released.leaks).toEqual([]);
    expect(released.verified.some((v) => v.fact.includes('vram'))).toBe(true);
    expect(await liveRunnerFiles(k.layout.vramDir)).toHaveLength(0);
    const used = await fakeGpu(k.layout.vramDir)();
    expect('value' in used && used.value.devices[0]?.usedBytes).toBe(BASE_USED);
    expect((await chat(f.url)).status).toBe(503);
    expect((await fetch(`${f.url}/health`)).status).toBe(404);
  }, 60_000);

  it('a tag the router renames (`:1b` → `:1B`, llama.cpp b11583) still loads, answers the human’s name and unloads', async () => {
    const k = kit('renamed');
    const f = await front(k.hold);
    expect(await until(() => f.listening())).toBe(true);
    const held = await k.hold.hold({ ...k.body, model: { ...k.body.model, id: 'tiny-model:1b' } });
    expect(held).toMatchObject({ ok: true });
    // Клиент шлёт имя человека — маршрутизатор знает только своё, фронт ведёт запрос удержанной.
    const response = await fetch(`${f.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tiny-model:1b', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    const answer = await response.text();
    expect(answer).toContain('function merge');
    // Обратно — имя, которое просил клиент: имя маршрутизатора фронт не выпускает.
    expect((JSON.parse(answer) as { model?: unknown }).model).toBe('tiny-model:1b');
    expect(answer).not.toContain('tiny-model:1B');
    const released = await k.hold.release();
    expect(released.released).toBe(true);
    expect(released.leaks).toEqual([]);
    expect(await liveRunnerFiles(k.layout.vramDir)).toHaveLength(0);
    // Выгрузку маршрутизатор ПРИНЯЛ по своему имени — не снятие дерева после отказа 400.
    const calls = readFileSync(join(k.layout.vramDir, 'router-calls.log'), 'utf8').trim();
    expect(calls.split('\n')).toEqual([
      '/models/load tiny-model:1B',
      '/models/unload tiny-model:1B',
    ]);
  }, 60_000);

  it('a core task holding the GPU slot refuses the hold at once — never a second model on one GPU', async () => {
    const slots = createSlotQueue();
    const k = kit('slot', slots);
    // Задача ядра взяла свою модель тем же маршрутом `local:own` на той же очереди слотов.
    const task = createOwnRoute({ ...ownOptions(k.layout), slots });
    const lease = await task.acquire({ taskId: 'task-1', model: 'tiny-model' }, silent);
    try {
      const outcome = await Promise.race([
        k.hold.hold(k.body),
        new Promise<'waited'>((done) => setTimeout(() => done('waited'), 3_000)),
      ]);
      expect(outcome).not.toBe('waited');
      expect(outcome).toMatchObject({ ok: false, code: 'local_slot_busy' });
      expect(await liveRunnerFiles(k.layout.vramDir)).toHaveLength(1);
      expect((await k.hold.view(null)).held).toBeNull();
    } finally {
      await task.release(lease, silent);
    }
  }, 60_000);

  it('a restarted core restores the hold: the slot is taken by the live server, no second load', async () => {
    const k = kit('restore');
    expect((await k.hold.hold(k.body)).ok).toBe(true);
    const first = await k.hold.view(null);
    // Новое ядро: свой экземпляр удержания и своя очередь слотов над тем же каталогом.
    const slots = createSlotQueue();
    const again = createLocalHold({
      workRoot: k.workRoot,
      journal: silent,
      leadArgs: [ROUTER],
      route: { slots, gpu: fakeGpu(k.layout.vramDir), settleMs: 2_000 },
    });
    await again.restore();
    expect(slots.held('gpu')).toBe(true);
    const view = await again.view(null);
    expect(view.live).toBe(true);
    expect(view.held?.origin).toBe(first.held?.origin);
    expect(await liveRunnerFiles(k.layout.vramDir)).toHaveLength(1);
    const released = await again.release();
    expect(released.leaks).toEqual([]);
    expect(await liveRunnerFiles(k.layout.vramDir)).toHaveLength(0);
  }, 60_000);

  it('a dead hold server is raised again by the next request on the stable port', async () => {
    const k = kit('revive');
    const f = await front(k.hold);
    expect((await k.hold.hold(k.body)).ok).toBe(true);
    const record = await k.hold.view(null);
    const leaseDir = readdirSync(join(k.workRoot, 'leases'))[0] ?? '';
    const state = readLeaseState(join(k.workRoot, 'leases', leaseDir));
    expect(state?.routeId).toBe(HOLD_ROUTE_ID);
    if (!state?.server) throw new Error('no server in the lease record');
    // Сервер умер не по кнопке (сбой, ООМ): дерево снято мимо удержания.
    await stopRouter(attachRouter(state.server));
    expect(await until(async () => (await liveRunnerFiles(k.layout.vramDir)).length === 0)).toBe(
      true,
    );
    const revived = await chat(f.url);
    expect(revived.status, revived.text).toBe(200);
    const view = await k.hold.view(null);
    expect(view.live).toBe(true);
    expect(view.held?.origin).not.toBe(record.held?.origin);
    expect(await liveRunnerFiles(k.layout.vramDir)).toHaveLength(1);
    await k.hold.release();
  }, 90_000);

  it('a server that died a moment ago is not answered from the liveness cache: the same request reaches the raised one', async () => {
    // Кэш живости заведомо свежий: без сброса по отказу соединения тот же запрос ушёл бы на мёртвый адрес.
    const k = kit('stale', createSlotQueue(), undefined, 600_000);
    const f = await front(k.hold);
    expect((await k.hold.hold(k.body)).ok).toBe(true);
    const warm = await chat(f.url);
    expect(warm.status, warm.text).toBe(200);
    const before = await k.hold.view(null);
    const leaseDir = readdirSync(join(k.workRoot, 'leases'))[0] ?? '';
    const state = readLeaseState(join(k.workRoot, 'leases', leaseDir));
    if (!state?.server) throw new Error('no server in the lease record');
    await stopRouter(attachRouter(state.server));
    expect(await until(async () => (await liveRunnerFiles(k.layout.vramDir)).length === 0)).toBe(
      true,
    );
    const revived = await chat(f.url);
    expect(revived.status, revived.text).toBe(200);
    const after = await k.hold.view(null);
    expect(after.held?.origin).not.toBe(before.held?.origin);
    expect(await liveRunnerFiles(k.layout.vramDir)).toHaveLength(1);
    await k.hold.release();
  }, 90_000);

  it('the stable port is taken the moment its previous owner lets it go', async () => {
    const k = kit('cutover');
    const { port } = await allocatePort();
    // Прежний llama-server панели ещё держит порт.
    const previous = createServer((_req, res) => res.end('previous'));
    await new Promise<void>((done) => previous.listen(port, '127.0.0.1', done));
    const f = await front(k.hold, port, 50);
    await new Promise((done) => setTimeout(done, 300));
    expect(f.listening()).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('previous');
    expect((await k.hold.hold(k.body)).ok).toBe(true);
    await new Promise<void>((done) => previous.close(() => done()));
    expect(await until(() => f.listening(), 5_000)).toBe(true);
    expect((await chat(f.url)).status).toBe(200);
    await k.hold.release();
  }, 60_000);
});
