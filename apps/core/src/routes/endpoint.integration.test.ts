import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  RouteDecisionRecord,
  RouteLease,
  RouteRecorder,
} from '@agentdeck/contracts/core/routes';
import { hasValue, type Fact } from '../platform/os-kind.ts';
import {
  createLivenessProbe,
  identityOfPid,
  type LivenessProbe,
  type ProcessIdentity,
} from '../platform/process-identity.ts';
import { decideEndpoint } from './endpoint.ts';
import { ownDir, ownOptions } from './local/own/__fixtures__/own-options.ts';
import { createOwnRoute } from './local/own/own.ts';
import { createSlotQueue } from './local/own/slot.ts';
import { createStubRoute } from './stub/stub.ts';

/**
 * F-73: `Route.endpoint` отдаёт адрес только доказанно живому серверу — личность (pid + старт)
 * жива и порт отвечает. Мёртвый сервер, номер, ушедший другому процессу, порт, занятый чужим
 * слушателем, — `null` и решение `endpoint` в журнал, никогда адрес. Процессы настоящие; граница
 * ОС подставлена только в «номер ушёл другому» (таблица отвечает «мёртв» по старту).
 */

const base = mkdtempSync(join(tmpdir(), 'endpoint-live-'));
const started: Promise<Fact<ProcessIdentity>>[] = [];
const track = (pid: number): void => void started.push(identityOfPid(pid));
afterAll(async () => {
  const probe = createLivenessProbe();
  // Только тот же процесс (pid + старт): номер убитого здесь мог уже уйти процессу соседнего набора.
  for (const read of await Promise.all(started))
    if (hasValue(read) && (await probe.isAlive(read.value)) === 'alive')
      process.kill(read.value.pid);
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // Windows держит каталог мгновение — временный каталог ОС уберёт сама.
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

async function goneWithin(pid: number, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

function rec() {
  const decisions: RouteDecisionRecord[] = [];
  const record: RouteRecorder = {
    decision: (d) => void decisions.push(d),
    created: () => undefined,
    verified: () => undefined,
    leak: () => undefined,
  };
  return { record, decisions };
}

/** Живость, где названный pid читается «мёртв» (его старт другой — номер ушёл другому процессу). */
function reusedFor(pids: Set<number>): LivenessProbe {
  const real = createLivenessProbe();
  return {
    ...real,
    isAlive: async (id, question) => (pids.has(id.pid) ? 'dead' : real.isAlive(id, question)),
  };
}

const stubPid = (lease: RouteLease): number =>
  Number(
    new URL(
      lease.resources.find((r) => r.kind === 'stub-server')?.ref ?? 'http://x',
    ).searchParams.get('pid'),
  );
const ownPid = (lease: RouteLease): number =>
  Number(
    /^pid (\d+) /.exec(lease.resources.find((r) => r.kind === 'model-server')?.ref ?? '')?.[1],
  );

/** Отказ с фактом живости: адрес судит свежий вопрос о живости, не снимок такта. */
const refusal = () =>
  expect.objectContaining({
    class: 'endpoint',
    facts: expect.arrayContaining([expect.objectContaining({ readClass: 'process.alive' })]),
    output: expect.objectContaining({ kind: 'refuse' }),
  });

describe('F-73 endpoint judge', () => {
  it('F-73 decideEndpoint: serve only alive + answering; dead, unknown, absent, wrong owner, silent port → refuse', () => {
    const s = 'srv';
    expect(decideEndpoint({ server: s, liveness: 'alive', health: 'answers' }).kind).toBe('serve');
    for (const input of [
      { server: s, liveness: 'dead' as const },
      { server: s, liveness: 'unknown' as const },
      { server: s, liveness: 'absent' as const },
      { server: s, liveness: 'alive' as const, health: 'wrong' as const },
      { server: s, liveness: 'alive' as const, health: { unknown: 'ECONNREFUSED' } },
      { server: s, liveness: 'alive' as const },
    ])
      expect(decideEndpoint(input).kind).toBe('refuse');
  });
});

describe('F-73 stub route endpoint — only a proven-alive server gets an address', () => {
  it('F-73 stub: alive → address, no decision; server killed → null + endpoint decision, here and after a restart', async () => {
    const route = createStubRoute({ name: 'ep-dead', script: ['x'] });
    const r = rec();
    const lease = await route.acquire({ taskId: 't', model: 'stub-model' }, r.record);
    const pid = stubPid(lease);
    track(pid);
    expect((await route.endpoint(lease, r.record))?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(r.decisions).toEqual([]);
    process.kill(pid);
    expect(await goneWithin(pid)).toBe(true);
    expect(await route.endpoint(lease, r.record)).toBeNull();
    const restarted = createStubRoute({ name: 'ep-dead', script: ['x'] });
    expect(await restarted.endpoint(lease, r.record)).toBeNull();
    expect(r.decisions).toEqual([refusal(), refusal()]);
    expect((await restarted.release(lease, rec().record)).leaks).toEqual([]);
  }, 60_000);

  it('F-73 stub: the pid reads dead by start (reused by another process) → null even though a process with that pid lives', async () => {
    const pids = new Set<number>();
    const route = createStubRoute({ name: 'ep-reuse', script: ['x'], probe: reusedFor(pids) });
    const r = rec();
    const lease = await route.acquire({ taskId: 't', model: 'stub-model' }, r.record);
    const pid = stubPid(lease);
    track(pid);
    pids.add(pid);
    expect(alive(pid)).toBe(true);
    expect(await route.endpoint(lease, r.record)).toBeNull();
    expect(r.decisions).toEqual([refusal()]);
    pids.clear();
    expect((await route.release(lease, rec().record)).leaks).toEqual([]);
  }, 60_000);

  it('F-73 stub: the port re-bound by a foreign listener (identity path answers another owner) → null', async () => {
    const pids = new Set<number>();
    // Таблица говорит «жив» (номер занят другим процессом с тем же стартом не бывает — здесь
    // проверяется второй факт): решает ответ порта.
    const real = createLivenessProbe();
    const probe: LivenessProbe = {
      ...real,
      isAlive: async (id, question) => (pids.has(id.pid) ? 'alive' : real.isAlive(id, question)),
    };
    const route = createStubRoute({ name: 'ep-port', script: ['x'], probe });
    const r = rec();
    const lease = await route.acquire({ taskId: 't', model: 'stub-model' }, r.record);
    const pid = stubPid(lease);
    track(pid);
    const endpoint = await route.endpoint(lease, r.record);
    const port = Number(new URL(endpoint?.baseUrl ?? 'http://x:1').port);
    process.kill(pid);
    expect(await goneWithin(pid)).toBe(true);
    pids.add(pid);
    const foreign = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ owner: 'someone-else' }));
    });
    // Windows отпускает порт убитого процесса не мгновенно: занять его, как только освободится.
    for (let tries = 0; ; tries += 1) {
      const bound = await new Promise<boolean>((done) => {
        foreign.once('error', () => done(false));
        foreign.listen(port, '127.0.0.1', () => done(true));
      });
      if (bound) break;
      if (tries > 100) throw new Error(`port ${port} never freed`);
      await new Promise((done) => setTimeout(done, 100));
    }
    try {
      expect(await route.endpoint(lease, r.record)).toBeNull();
      expect(r.decisions).toEqual([
        expect.objectContaining({
          class: 'endpoint',
          facts: [
            { readClass: 'process.alive', kind: 'value' },
            { readClass: 'route.availability', kind: 'value' },
          ],
          reasons: expect.arrayContaining([
            expect.stringMatching(/port answers as another server/),
          ]),
        }),
      ]);
    } finally {
      await new Promise((done) => foreign.close(done));
      pids.clear();
    }
    await route.release(lease, rec().record);
  }, 60_000);
});

describe('F-73 local:own endpoint — only a proven-alive server gets an address', () => {
  it('F-73 local:own: alive → address, no decision; pid reused → null; server killed → null; a restarted core the same', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'own-')));
    const pids = new Set<number>();
    const options = { ...ownOptions(layout), probe: reusedFor(pids) };
    const route = createOwnRoute({ ...options, slots: createSlotQueue() });
    const r = rec();
    const lease = await route.acquire({ taskId: 't', model: 'tiny-model' }, r.record);
    const pid = ownPid(lease);
    track(pid);
    expect((await route.endpoint(lease, r.record))?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(r.decisions.filter((d) => d.class === 'endpoint')).toEqual([]);
    pids.add(pid);
    expect(await route.endpoint(lease, r.record)).toBeNull();
    pids.clear();
    // Убит хранитель — личность аренды; сервер под ним ещё отвечает на порту: адреса нет всё равно.
    process.kill(pid);
    expect(await goneWithin(pid)).toBe(true);
    expect(await route.endpoint(lease, r.record)).toBeNull();
    const restarted = createOwnRoute({ ...options, slots: createSlotQueue() });
    expect(await restarted.endpoint(lease, r.record)).toBeNull();
    expect(r.decisions.filter((d) => d.class === 'endpoint')).toEqual([
      refusal(),
      refusal(),
      refusal(),
    ]);
    await route.release(lease, rec().record);
  }, 120_000);
});
