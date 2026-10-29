import { createServer, type Server } from 'node:http';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { afterEach, describe, expect, it } from 'vitest';
import { createStandRegistry, createStandWatch, readHealth } from './index.ts';

/**
 * Стенд (04:75-77): эпоха растёт на каждом переходе здоров ↔ нездоров и на смене личности
 * процесса — прогон, во время которого она сдвинулась, получает `no-verdict(stand)` (C).
 * P44 `stand.health`: нет ответа / таймаут — `unknown`, и стенд НЕ здоров (никогда «здоров» по
 * непрочитанному). Здоровье читается настоящим HTTP до настоящего сервера.
 */

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.map((s) => {
      s.closeAllConnections();
      return new Promise((done) => s.close(done));
    }),
  );
  servers = [];
});

async function healthServer(): Promise<{ url: string; set(code: number): void; port: number }> {
  let code = 200;
  const server = createServer((_req, res) => {
    res.statusCode = code;
    res.end('x');
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/health`, port, set: (c) => (code = c) };
}

describe('stand epoch over a real health endpoint', () => {
  it('healthy → 500 → healthy moves the epoch twice; a steady state does not', async () => {
    const s = await healthServer();
    const watch = createStandWatch({ health: s.url });
    expect(await watch.tick()).toEqual({ epoch: 0, healthy: true, lastReason: 'status 200' });
    expect((await watch.tick()).epoch).toBe(0);
    s.set(500);
    expect(await watch.tick()).toEqual({ epoch: 1, healthy: false, lastReason: 'status 500' });
    s.set(204);
    expect(await watch.tick()).toMatchObject({ epoch: 2, healthy: true });
  });
  it('process identity changed while both reads are healthy → restart, epoch moves', async () => {
    const s = await healthServer();
    let id = '101@t1';
    const watch = createStandWatch({
      health: s.url,
      identity: async () => ({ value: id }),
    });
    await watch.tick();
    id = '202@t2';
    expect(await watch.tick()).toMatchObject({ epoch: 1, healthy: true });
    // Личность не прочиталась — не «перезапуск»: эпоха стоит.
    const unread = createStandWatch({
      health: s.url,
      identity: async () => ({ unknown: 'ps failed' }),
    });
    await unread.tick();
    expect((await unread.tick()).epoch).toBe(0);
  });
  it('one read at a time: a timer tick and a run asking itself do not count a transition twice', async () => {
    let calls = 0;
    let release: (f: Fact<number>) => void = () => undefined;
    const watch = createStandWatch({
      health: 'http://unused',
      read: () => {
        calls += 1;
        return new Promise((done) => (release = done));
      },
    });
    const a = watch.tick();
    const b = watch.tick();
    release({ value: 200 });
    expect(await a).toBe(await b);
    expect(calls).toBe(1);
  });
  it('registry: no stand → null epoch (run without a stand); attached → its epoch; detached → a moved epoch, not null', async () => {
    const s = await healthServer();
    const registry = createStandRegistry();
    expect(await registry.standEpoch('t')).toBeNull();
    const watch = createStandWatch({ health: s.url, intervalMs: 60_000 });
    registry.attach('t', watch);
    const before = await registry.standEpoch('t');
    expect(before).toBe(0);
    registry.detach('t');
    // Стенд снят посреди прогона: «после» не `null` (как будто стенда не было), а сдвиг.
    const after = await registry.standEpoch('t');
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });
});

/** Здоровье по сценарию: чтение — внешняя граница (сеть), всё остальное — настоящее. */
function scripted(answers: Fact<number>[]): (url: string) => Promise<Fact<number>> {
  return async () => answers.shift() ?? { value: 200 };
}

describe('stand epoch as zone C reads it (04:75-77: a stand restart → no-verdict(stand), never red)', () => {
  it('a restart between timer ticks is seen: the run asks for a fresh read before and after', async () => {
    const registry = createStandRegistry();
    // Таймер на минуту — между «до» и «после» он не сработает; сдвиг видит только свежее чтение.
    registry.attach(
      't',
      createStandWatch({
        health: 'http://stand',
        intervalMs: 60_000,
        read: scripted([{ value: 200 }, { value: 503 }, { value: 200 }]),
      }),
    );
    const before = await registry.standEpoch('t');
    const after = await registry.standEpoch('t');
    expect(after).not.toBe(before);
  });

  it('re-attach under the same key moves the epoch (a new watch does not start back at 0)', async () => {
    const registry = createStandRegistry();
    const watch = () =>
      createStandWatch({ health: 'http://stand', intervalMs: 60_000, read: scripted([]) });
    registry.attach('t', watch());
    const before = await registry.standEpoch('t');
    registry.attach('t', watch());
    const after = await registry.standEpoch('t');
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it('a stand down for the whole run moves the epoch: unhealthy at either end is never a verdict', async () => {
    const registry = createStandRegistry();
    registry.attach(
      't',
      createStandWatch({
        health: 'http://stand',
        intervalMs: 60_000,
        read: async () => ({ unknown: 'ECONNREFUSED' }),
      }),
    );
    const before = await registry.standEpoch('t');
    const after = await registry.standEpoch('t');
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it('per-unit stands (<taskId>/<unit>) are found by the task id and by the unit', async () => {
    const registry = createStandRegistry();
    const answers: Fact<number>[] = [{ value: 200 }, { value: 200 }, { value: 500 }];
    registry.attach(
      't/u1',
      createStandWatch({ health: 'http://stand', intervalMs: 60_000, read: scripted(answers) }),
    );
    const byTask = await registry.standEpoch('t');
    expect(byTask).not.toBeNull();
    expect(await registry.standEpoch('t', 'u1')).toBe(byTask);
    expect(await registry.standEpoch('t', 'u1')).not.toBe(byTask);
    expect(await registry.standEpoch('other')).toBeNull();
  });

  it('a throwing identity or health reader never becomes an unhandled rejection; the stand reads unhealthy', async () => {
    const seen: unknown[] = [];
    const onRejection = (e: unknown): void => {
      seen.push(e);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const watch = createStandWatch({
        health: 'http://stand',
        intervalMs: 5,
        read: async () => {
          throw new Error('health blew up');
        },
        identity: async () => {
          throw new Error('ps blew up');
        },
      });
      watch.start();
      await new Promise((done) => setTimeout(done, 40));
      watch.stop();
      expect(await watch.tick()).toMatchObject({ healthy: false });
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('P44 stand.health fault table: an unread health is never healthy', () => {
  it('nothing listening → unknown, the stand is not healthy', async () => {
    const s = await healthServer();
    await new Promise((done) => servers.pop()?.close(done));
    const got = await readHealth(s.url);
    expect(got).toMatchObject({ unknown: expect.any(String) });
    const watch = createStandWatch({ health: s.url });
    expect(await watch.tick()).toMatchObject({ healthy: false });
  });
  it('timeout → unknown (class stand.health, onUnknown refuse)', async () => {
    const fireNow = (fn: () => void) => {
      queueMicrotask(fn);
      return { cancel: () => undefined };
    };
    const hang = createServer(() => undefined);
    servers.push(hang);
    await new Promise<void>((done) => hang.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(hang.address() as { port: number }).port}/`;
    const got = await readHealth(url, { setTimer: fireNow });
    expect(got).toMatchObject({ unknown: expect.stringMatching(/timeout/) });
    hang.closeAllConnections();
  });
  it('healthy then unreadable → transition counted (epoch +1), not held as healthy', async () => {
    const watch = createStandWatch({
      health: 'http://x',
      read: (() => {
        const answers: Fact<number>[] = [{ value: 200 }, { unknown: 'ECONNREFUSED' }];
        return async () => answers.shift() ?? { unknown: 'none' };
      })(),
    });
    await watch.tick();
    expect(await watch.tick()).toEqual({ epoch: 1, healthy: false, lastReason: 'ECONNREFUSED' });
  });
});
