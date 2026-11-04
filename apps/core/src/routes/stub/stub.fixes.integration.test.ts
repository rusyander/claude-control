/**
 * Маршрут-заглушка на сбойных путях (ревью core-s2): сервер, у которого не записан ресурс или
 * прервана аренда, не переживает отказ; диалект вне заглушки — отказ до запуска; возврат к
 * мёртвому серверу — отказ, а не чужой порт; сбой записи при возврате не даёт ложного «чисто».
 * Каждый запущенный сервер снимается в afterAll, что бы ни случилось в тесте.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type {
  Dialect,
  RouteLease,
  RouteRecorder,
  RouteResource,
} from '@agentdeck/contracts/core/routes';
import { DIALECT_IDS } from '@agentdeck/stub-model';
import { bindLoopback, type BindProbe } from '../../platform/ports.ts';
import { sleep } from '../../platform/os-kind.ts';
import { RouteAborted, RouteRefused } from '../lease.ts';
import {
  createLivenessProbe,
  type Liveness,
  type ProcessIdentity,
} from '../../platform/process-identity.ts';
import { createStubRoute, parseStubServerRef, STUB_CAPS } from './stub.ts';

/** Личности запущенных серверов-заглушек (pid + старт из ссылки ресурса), для уборки. */
const seen: ProcessIdentity[] = [];
const see = (ref: string): void => {
  const parsed = parseStubServerRef(ref);
  if (!('unreadable' in parsed)) seen.push(parsed.identity);
};
/**
 * Жизнь сервера по личности (pid + старт), не по номеру: Windows под нагрузкой отдаёт
 * освободившийся pid новому процессу, а на Linux убитый, но ещё не подобранный ребёнок теста —
 * зомби, и `kill(pid, 0)` видит его живым (g13 p10, C5 shutdown в контейнере). Зомби — `dead`.
 */
const life = async (pid: number): Promise<Liveness> => {
  const identity = seen.findLast((one) => one.pid === pid);
  if (!identity) throw new Error(`pid ${pid} was never seen in a resource ref`);
  return createLivenessProbe().isAlive(identity, { fresh: true });
};

afterAll(async () => {
  // Только тот же процесс (pid + старт из ссылки ресурса): номер, ушедший процессу соседнего
  // набора тестов, не трогается. Живость — по снимку после вопроса, не из кэша такта.
  const probe = createLivenessProbe();
  for (const identity of seen)
    if ((await probe.isAlive(identity, { fresh: true })) === 'alive') process.kill(identity.pid);
});

/** pid из ссылки ресурса `stub-server` (`…?pid=N…`), сразу в уборку. */
function pidOfRef(ref: string): number {
  const pid = Number(new URL(ref).searchParams.get('pid'));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid in ${ref}`);
  see(ref);
  return pid;
}

const pidOf = (lease: RouteLease): number =>
  pidOfRef(lease.resources.find((r) => r.kind === 'stub-server')?.ref ?? '');

/** Жив ли процесс спустя до `ms` (остановка дерева асинхронна на POSIX). */
async function goneWithin(pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while ((await life(pid)) !== 'dead') {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

async function portFree(port: number): Promise<boolean> {
  try {
    const probe = await bindLoopback(port);
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

function recorder(overrides: Partial<RouteRecorder> = {}) {
  const events: string[] = [];
  const resources: RouteResource[] = [];
  const record: RouteRecorder = {
    decision: () => undefined,
    created: (r) => {
      resources.push(r);
      events.push(`created:${r.kind}`);
    },
    verified: (_rid, fact) => void events.push(`verified:${fact}`),
    leak: (_rid, reason) => void events.push(`leak:${reason}`),
    ...overrides,
  };
  return { record, events, resources };
}

/** Исход аренды без броска: красный прогон старого кода отдаёт аренду — её надо снять. */
async function settle(
  pending: Promise<RouteLease>,
): Promise<{ lease: RouteLease } | { error: unknown }> {
  return pending.then(
    (lease) => ({ lease }),
    (error: unknown) => ({ error }),
  );
}

describe('stub route on failure paths (review core-s2)', () => {
  it('F-71: the journal refusing the resource record stops the started server before the refusal', async () => {
    const route = createStubRoute({ name: 'f71', script: ['x'] });
    const refs: string[] = [];
    const r = recorder({
      created: (resource) => {
        refs.push(resource.ref);
        throw new Error('journal write failed (test)');
      },
    });
    await expect(route.acquire({ taskId: 't', model: 'stub-model' }, r.record)).rejects.toThrow(
      'journal write failed (test)',
    );
    expect(refs).toHaveLength(1);
    const pid = pidOfRef(refs[0]!);
    expect(await goneWithin(pid)).toBe(true);
    // Остановка ядра тоже ничего не держит: сервер не в списке маршрута.
    expect(await route.shutdown(recorder().record)).toEqual({ verified: [], leaks: [] });
  }, 60_000);

  it('F-72: a dialect the stub does not speak is refused before any server starts', async () => {
    const ports: number[] = [];
    const bind: BindProbe = async (port) => {
      const probe = await bindLoopback(port);
      ports.push(probe.port);
      return probe;
    };
    const route = createStubRoute({ name: 'f72', script: ['x'], bind });
    const r = recorder();
    const outcome = await settle(
      // Gemini API заглушка уже говорит (этап 10) — нужен диалект, которого нет ни у кого.
      route.acquire(
        { taskId: 't', model: 'stub-model', dialect: 'bedrock-converse' as Dialect },
        r.record,
      ),
    );
    if ('lease' in outcome) {
      pidOf(outcome.lease);
      await route.release(outcome.lease, recorder().record);
    }
    expect('error' in outcome && outcome.error).toBeInstanceOf(RouteRefused);
    expect((outcome as { error: RouteRefused }).error.code).toBe('no_channel');
    expect(r.resources).toEqual([]);
    expect(ports).toEqual([]);
  }, 60_000);

  it('F-118: the route speaks exactly the dialects of the stub library', () => {
    expect(STUB_CAPS.dialects).toEqual([...DIALECT_IDS]);
  });

  it('F-73: endpoint() refuses a lease whose server is dead, in the same core and after a restart', async () => {
    const route = createStubRoute({ name: 'f73', script: ['x'] });
    const r = recorder();
    const lease = await route.acquire({ taskId: 't', model: 'stub-model' }, r.record);
    const pid = pidOf(lease);
    expect((await route.endpoint(lease, r.record))?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    process.kill(pid);
    expect(await goneWithin(pid)).toBe(true);

    // Мёртвый сервер — не адрес, а `null` с решением `endpoint` (контракт F-73).
    expect(await route.endpoint(lease, r.record)).toBeNull();
    const restarted = createStubRoute({ name: 'f73', script: ['x'] });
    expect(await restarted.endpoint(lease, r.record)).toBeNull();
    // Возврат мёртвого сервера — проверка по миру: процессов нет, порт свободен.
    const outcome = await restarted.release(lease, r.record);
    expect(outcome.leaks).toEqual([]);
    expect(outcome.verified).toHaveLength(1);
  }, 60_000);

  it('C5: a journal failure during release leaves the lease held — the retry stops and records it, not a false clean', async () => {
    const route = createStubRoute({ name: 'c5', script: ['x'] });
    const lease = await route.acquire({ taskId: 't', model: 'stub-model' }, recorder().record);
    const pid = pidOf(lease);
    const failing = recorder({
      verified: () => {
        throw new Error('journal write failed (test)');
      },
    });
    await expect(route.release(lease, failing.record)).rejects.toThrow('journal write failed');
    const r = recorder();
    const retry = await route.release(lease, r.record);
    expect(retry.verified).toHaveLength(1);
    expect(r.events).toEqual([expect.stringMatching(/^verified:server stopped/)]);
    // По личности (pid + старт), не по номеру: в полном прогоне Windows отдаёт освободившийся pid
    // новому процессу за секунды, и `kill(pid, 0)` видел бы чужой живой процесс (01.11).
    const identity = seen.find((one) => one.pid === pid)!;
    expect(await createLivenessProbe().isAlive(identity, { fresh: true })).toBe('dead');
  }, 60_000);

  it('C5: shutdown goes past a failing release and stops every server, then names the failure', async () => {
    const route = createStubRoute({ name: 'c5-shutdown', script: ['x'] });
    const first = await route.acquire({ taskId: 'a', model: 'stub-model' }, recorder().record);
    const second = await route.acquire({ taskId: 'b', model: 'stub-model' }, recorder().record);
    const pids = [pidOf(first), pidOf(second)];
    let calls = 0;
    const r = recorder({
      verified: () => {
        calls += 1;
        if (calls === 1) throw new Error('journal write failed (test)');
      },
    });
    await expect(route.shutdown(r.record)).rejects.toThrow(
      /1 release\(s\) failed.*journal write failed/,
    );
    expect(await Promise.all(pids.map(life))).toEqual(['dead', 'dead']);
  }, 60_000);

  it('C11: an abort during the server start stops the server and refuses with RouteAborted', async () => {
    const ports: number[] = [];
    const bind: BindProbe = async (port) => {
      const probe = await bindLoopback(port);
      ports.push(probe.port);
      return probe;
    };
    const route = createStubRoute({ name: 'c11', script: ['x'], bind });
    const r = recorder();
    const controller = new AbortController();
    const pending = settle(
      route.acquire({ taskId: 't', model: 'stub-model', signal: controller.signal }, r.record),
    );
    // Синхронная проверка в начале уже пройдена — прерывание приходит посреди запуска.
    controller.abort();
    const outcome = await pending;
    if ('lease' in outcome) {
      pidOf(outcome.lease);
      await route.release(outcome.lease, recorder().record);
    }
    expect('error' in outcome && outcome.error).toBeInstanceOf(RouteAborted);
    expect(r.resources).toEqual([]);
    // Сервер, если успел подняться, снят: порт свободен.
    await sleep(1_000);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(await portFree(port)).toBe(true);
  }, 60_000);

  it('C9: a relative script module is refused when the route is built (the server runs in another folder)', () => {
    expect(() =>
      createStubRoute({ name: 'c9', script: { module: './script.mjs', export: 'script' } }),
    ).toThrow(/absolute path/);
  });
});
