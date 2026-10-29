import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { RouteLease, RouteRecorder } from '@agentdeck/contracts/core/routes';
import { hasValue, type Fact } from '../../../platform/os-kind.ts';
import { createLivenessProbe, type ProcessIdentity } from '../../../platform/process-identity.ts';
import { RouteAborted } from '../../lease.ts';
import { alive, identityNow, livenessNow } from './__fixtures__/fake-gpu.ts';
import { ownDir, ownOptions } from './__fixtures__/own-options.ts';
import { until } from './__fixtures__/restart-kit.ts';
import { createOwnRoute } from './own.ts';
import { createSlotQueue } from './slot.ts';

/**
 * Остаток дерева сервера `local:own` (core-s2 F-64, F-66): граница ОС подставлена в четырёх
 * местах — снимок личности хранителя «не прочитан», остановка дерева «остаток» (как сбойная
 * таблица процессов) или «никого не нашла» (хранитель невидим поиску по метке), и ответ номера
 * процесса (номер снятого отдан чужому — Windows делает это за миллисекунды); всё остальное —
 * настоящие процессы, хранитель и подставной маршрутизатор.
 *
 * «Снят» проверяется по ЛИЧНОСТИ (номер + старт), не по номеру: под общей нагрузкой номер
 * снятого сервера через миг отвечал чужим процессом (полный прогон 29.10: `leaks: []`, а
 * `alive(pid)` — истина).
 */

const flags = vi.hoisted(() => ({
  unreadIdentity: false,
  residual: false,
  /** Остановка «никого не нашла»: чистый отчёт без единой цели, хранитель жив. */
  invisible: false,
  keeperPids: [] as number[],
  /** Номера, которые «отвечают» после остановки (чужой процесс на номере снятого). */
  answering: new Set<number>(),
  /** Пока снимок «не отвечает» — прочитать личности настоящей таблицей (сервер ещё жив). */
  capture: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('../../../platform/process-identity.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../platform/process-identity.ts')>();
  return {
    ...real,
    identityOfPid: async (...args: Parameters<typeof real.identityOfPid>) => {
      const [pid] = args;
      if (flags.unreadIdentity && pid !== process.pid) {
        flags.keeperPids.push(pid);
        // Хранитель успевает запустить сервер, а снимок таблицы не отвечает.
        await new Promise((done) => setTimeout(done, 1_500));
        await flags.capture?.();
        return { unknown: 'process table unread (test)' };
      }
      return real.identityOfPid(...args);
    },
  };
});

vi.mock('../../../platform/tree-stop.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../platform/tree-stop.ts')>();
  return {
    ...real,
    stopTree: async (...args: Parameters<typeof real.stopTree>) => {
      const [root] = args;
      // Остановка «не сняла» корень: процесс живёт, отчёт называет остаток.
      if (flags.residual) return { targeted: [root], sweepFound: [], residual: [root] };
      if (flags.invisible) return { targeted: [], sweepFound: [], residual: [] };
      return real.stopTree(...args);
    },
  };
});

vi.mock('../../../platform/kept-launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../platform/kept-launch.ts')>();
  return {
    ...real,
    pidAlive: (pid: number) => flags.answering.has(pid) || real.pidAlive(pid),
  };
});

const base = mkdtempSync(join(tmpdir(), 'own-leftover-'));
// Личность (pid + старт) читается настоящей таблицей в момент записи, мимо подмены выше: номер,
// убитый здесь и ушедший процессу соседнего набора, уборка не тронет.
const started: Promise<Fact<ProcessIdentity>>[] = [];
const track = (...pids: number[]): void => {
  for (const pid of pids) started.push(createLivenessProbe(undefined, 0).identityOf(pid));
};
/** Личность живого процесса настоящей таблицей (мимо подмены «не прочитан»); нет — проверка не начинается. */
async function realIdentity(pid: number): Promise<ProcessIdentity> {
  const read = await createLivenessProbe(undefined, 0).identityOf(pid);
  if (!hasValue(read)) throw new Error(`no identity for pid ${pid}: ${JSON.stringify(read)}`);
  return read.value;
}
afterAll(async () => {
  const probe = createLivenessProbe(undefined, 0);
  for (const read of await Promise.all(started))
    if (hasValue(read) && (await probe.isAlive(read.value)) === 'alive')
      process.kill(read.value.pid);
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // Windows держит каталог хранителя ещё мгновение — временный каталог ОС уберёт сама.
  }
  // Уборка читает таблицу процессов на каждый номер: под общей нагрузкой это дольше 20 с.
}, 120_000);

function rec() {
  const events: string[] = [];
  const record: RouteRecorder = {
    decision: () => undefined,
    created: () => undefined,
    verified: (_rid, fact) => void events.push(`verified:${fact}`),
    leak: (_rid, reason) => void events.push(`leak:${reason}`),
  };
  return { record, events };
}

const serverPid = (lease: RouteLease): number =>
  Number(
    /^pid (\d+) /.exec(lease.resources.find((r) => r.kind === 'model-server')?.ref ?? '')?.[1],
  );

describe('core-s2 local:own — a server tree not proven stopped keeps the slot (F-64, F-66)', () => {
  it('F-66 local:own: release whose tree stop reports a residual keeps the slot, the lease and its dir; a second acquire waits; the next release finishes', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'residual-')));
    const slots = createSlotQueue();
    const route = createOwnRoute({ ...ownOptions(layout), slots });
    const lease = await route.acquire({ taskId: 'a', model: 'tiny-model' }, rec().record);
    const pid = serverPid(lease);
    track(pid);
    const server = await identityNow(pid);
    const dir = lease.resources.find((r) => r.kind === 'tmpdir')?.ref ?? '';

    flags.residual = true;
    const first = await route.release(lease, rec().record).finally(() => {
      flags.residual = false;
    });
    expect(first.leaks.map((l) => l.reason)).toEqual([
      `tree residual: ${pid}`,
      expect.stringMatching(/^lease dir kept: model server not proven stopped \(tree residual/),
      expect.stringMatching(/^slot gpu kept: model server not proven stopped \(tree residual/),
    ]);
    expect(await livenessNow(server)).toBe('alive');
    expect(slots.held('gpu')).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'lease.json'), 'utf8')).leaseId).toBe(lease.leaseId);

    // Второй запрос ждёт: второй сервер рядом с живым первым не поднимается.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const second = await route
      .acquire({ taskId: 'b', model: 'tiny-model', signal: controller.signal }, rec().record)
      .then(
        async (l2) => (track(serverPid(l2)), await route.release(l2, rec().record), 'granted'),
        (error: unknown) => error,
      );
    expect(second).toBeInstanceOf(RouteAborted);

    const again = await route.release(lease, rec().record);
    expect(again.leaks).toEqual([]);
    expect(await livenessNow(server)).toBe('dead');
    expect(slots.held('gpu')).toBe(false);
  }, 120_000);

  it('F-64 local:own: keeper identity unread at start → the keeper and the server it launched are stopped by marker before the slot returns; nothing left alive', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'unread-')));
    const pidFile = join(layout.dir, 'server.pid');
    const slots = createSlotQueue();
    const route = createOwnRoute({
      ...ownOptions(layout),
      server: {
        command: process.execPath,
        leadArgs: [
          '-e',
          "require('fs').writeFileSync(process.env.PID_OUT, String(process.pid)); setInterval(() => {}, 1000)",
          '--',
        ],
        env: { PID_OUT: pidFile },
      },
      slots,
    });
    // Личности хранителя и сервера — настоящей таблицей, пока подмена «не отвечает», до остановки.
    const ids: ProcessIdentity[] = [];
    flags.capture = async () => {
      ids.push(await realIdentity(flags.keeperPids[0] ?? 0));
      // Сервер пишет файл номера первым делом; под нагрузкой его старт дольше окна подмены —
      // ждётся сама запись (снимок «не отвечает» дольше, остановка ещё не началась).
      if (!(await until(() => existsSync(pidFile), 60_000)))
        throw new Error('server never wrote its pid');
      ids.push(await realIdentity(Number(readFileSync(pidFile, 'utf8'))));
    };
    flags.unreadIdentity = true;
    const got = await route
      .acquire({ taskId: 't', model: 'tiny-model' }, rec().record)
      .then(
        () => 'granted',
        (error: unknown) => error,
      )
      .finally(() => {
        flags.unreadIdentity = false;
        flags.capture = undefined;
      });
    const server = Number(readFileSync(pidFile, 'utf8'));
    track(server, ...flags.keeperPids);
    expect(got).toBeInstanceOf(Error);
    expect((got as Error).message).toMatch(/keeper identity unread/);
    expect(flags.keeperPids).toHaveLength(1);
    expect(ids.map((id) => id.pid)).toEqual([flags.keeperPids[0], server]);
    for (const id of ids) expect(await livenessNow(id)).toBe('dead');
    expect(slots.held('gpu')).toBe(false);
  }, 120_000);

  it('F-64 local:own: a failed start whose leftover is not proven stopped survives a core restart — the restarted core keeps the slot until a stop proves it gone', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'restart-left-')));
    const pidFile = join(layout.dir, 'server.pid');
    flags.keeperPids.length = 0;
    const first = createOwnRoute({
      ...ownOptions(layout),
      server: {
        command: process.execPath,
        leadArgs: [
          '-e',
          "require('fs').writeFileSync(process.env.PID_OUT, String(process.pid)); setInterval(() => {}, 1000)",
          '--',
        ],
        env: { PID_OUT: pidFile },
      },
      slots: createSlotQueue(),
    });
    // Запуск не доказан снятым: личность хранителя не прочитана, остановка называет остаток.
    flags.unreadIdentity = true;
    flags.residual = true;
    const failed = await first
      .acquire({ taskId: 'a', model: 'tiny-model' }, rec().record)
      .then(
        () => 'granted',
        (error: unknown) => error,
      )
      .finally(() => {
        flags.unreadIdentity = false;
      });
    track(...flags.keeperPids);
    // Хранитель жив (остановка подменена «остатком») и сервер под ним поднимается: под нагрузкой
    // старт node дольше окна подмены — ждётся его собственная запись номера.
    expect(await until(() => existsSync(pidFile), 60_000)).toBe(true);
    const server = Number(readFileSync(pidFile, 'utf8'));
    track(server);
    expect(failed).toBeInstanceOf(Error);
    expect(alive(server)).toBe(true);
    // Остановка подменена «остатком» — оба живы, их личности читаются настоящей таблицей.
    const serverId = await realIdentity(server);
    const keeperId = await realIdentity(flags.keeperPids[0] ?? 0);

    // Ядро перезапущено: новая очередь, тот же диск. Остаток всё ещё не снимается.
    const slots = createSlotQueue();
    const points: string[] = [];
    const second = createOwnRoute({
      ...ownOptions(layout),
      slots,
      journal: {
        ...rec().record,
        decision: (d) => void (d.humanPoint && points.push(d.humanPoint.subject)),
      },
    });
    // Возврат состояния — событием (освобождение не держимой аренды ждёт его): под нагрузкой он
    // дольше 1,5 с, и отказ по сроку наступал раньше точки человека.
    const none = { leaseId: 'none', routeId: 'local:own', model: 'tiny-model', resources: [] };
    expect(await second.release(none, rec().record)).toEqual({ verified: [], leaks: [] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const next = await second
      .acquire({ taskId: 'b', model: 'tiny-model', signal: controller.signal }, rec().record)
      .then(
        async (l2) => {
          // Красный путь: слот выдан рядом с живым остатком — снять выданное, затем упасть.
          track(serverPid(l2));
          flags.residual = false;
          await second.release(l2, rec().record);
          return 'granted';
        },
        (error: unknown) => error,
      );
    expect(next).toBeInstanceOf(RouteAborted);
    expect(slots.held('gpu')).toBe(true);
    expect(alive(server)).toBe(true);
    expect(points).toEqual([expect.stringMatching(/^failed model server start .* \(lease /)]);

    // Остановка доказала: остатка нет — слот свободен, каталог аренды убран.
    flags.residual = false;
    const done = await second.shutdown(rec().record);
    expect(done.leaks).toEqual([]);
    expect(await livenessNow(serverId)).toBe('dead');
    expect(await livenessNow(keeperId)).toBe('dead');
    expect(slots.held('gpu')).toBe(false);
  }, 120_000);

  it('F-64 local:own: a failed-start leftover gone by the restart is proven stopped at restore — the slot is free at once', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'restart-gone-')));
    flags.keeperPids.length = 0;
    const first = createOwnRoute({ ...ownOptions(layout), slots: createSlotQueue() });
    flags.unreadIdentity = true;
    flags.residual = true;
    const failed = await first
      .acquire({ taskId: 'a', model: 'tiny-model' }, rec().record)
      .catch((error: unknown) => error)
      .finally(() => {
        flags.unreadIdentity = false;
        flags.residual = false;
      });
    track(...flags.keeperPids);
    expect(failed).toBeInstanceOf(Error);
    const keeperId = await realIdentity(flags.keeperPids[0] ?? 0);
    const slots = createSlotQueue();
    const second = createOwnRoute({ ...ownOptions(layout), slots });
    const lease = await second.acquire({ taskId: 'b', model: 'tiny-model' }, rec().record);
    track(serverPid(lease));
    expect(await livenessNow(keeperId)).toBe('dead');
    expect((await second.release(lease, rec().record)).leaks).toEqual([]);
    expect(slots.held('gpu')).toBe(false);
  }, 120_000);

  /** Неудачный запуск с остатком (личность хранителя не прочитана, остановка «остаток»). */
  async function failedStart(name: string) {
    const layout = ownDir(mkdtempSync(join(base, `${name}-`)));
    flags.keeperPids.length = 0;
    const first = createOwnRoute({ ...ownOptions(layout), slots: createSlotQueue() });
    flags.unreadIdentity = true;
    flags.residual = true;
    const failed = await first
      .acquire({ taskId: 'a', model: 'tiny-model' }, rec().record)
      .catch((error: unknown) => error)
      .finally(() => {
        flags.unreadIdentity = false;
        flags.residual = false;
      });
    track(...flags.keeperPids);
    expect(failed).toBeInstanceOf(Error);
    const keeper = flags.keeperPids[0] ?? 0;
    return { layout, keeper, keeperId: await realIdentity(keeper) };
  }

  /** Перезапущенное ядро; возврат состояния — событием (освобождение не держимой аренды ждёт его). */
  async function restarted(layout: ReturnType<typeof ownDir>) {
    const slots = createSlotQueue();
    const reasons: string[] = [];
    const route = createOwnRoute({
      ...ownOptions(layout),
      slots,
      journal: {
        ...rec().record,
        decision: (d) => void (d.humanPoint && reasons.push(d.humanPoint.reason)),
      },
    });
    const none = { leaseId: 'none', routeId: 'local:own', model: 'tiny-model', resources: [] };
    expect(await route.release(none, rec().record)).toEqual({ verified: [], leaks: [] });
    return { route, slots, reasons };
  }

  it('F-64 local:own: a keeper taken by the marker stop is judged by identity — its number answering after the stop is a reused pid (slot free, no point); a keeper the marker stop never saw whose number answers keeps the slot with a point', async () => {
    // Номер снятого хранителя отдан чужому процессу: отвечает, но хранитель снят по личности.
    const reused = await failedStart('reused');
    flags.answering.add(reused.keeper);
    const a = await restarted(reused.layout).finally(() => flags.answering.clear());
    expect(await livenessNow(reused.keeperId)).toBe('dead');
    expect(a.reasons).toEqual([]);
    expect(a.slots.held('gpu')).toBe(false);
    expect((await a.route.shutdown(rec().record)).leaks).toEqual([]);

    // Поиск по метке хранителя не увидел (отчёт чист, целей нет), а его номер жив — остаток.
    const unseen = await failedStart('unseen');
    flags.invisible = true;
    const b = await restarted(unseen.layout).finally(() => {
      flags.invisible = false;
    });
    expect(await livenessNow(unseen.keeperId)).toBe('alive');
    expect(b.reasons).toEqual([
      `keeper pid ${unseen.keeper} alive after the stop, identity unread`,
    ]);
    expect(b.slots.held('gpu')).toBe(true);
    // Остановка видит хранителя — снят доказанно, слот свободен.
    expect((await b.route.shutdown(rec().record)).leaks).toEqual([]);
    expect(await livenessNow(unseen.keeperId)).toBe('dead');
    expect(b.slots.held('gpu')).toBe(false);
  }, 120_000);
});
