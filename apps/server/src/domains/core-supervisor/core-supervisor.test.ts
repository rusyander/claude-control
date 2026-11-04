import { describe, expect, it } from 'vitest';
import { CORE_HOME_BUSY_EXIT } from '@agentdeck/contracts/core/supervisor';
import {
  CORE_FAULT_WINDOW_MS,
  coreBackoffMs,
  createCoreSupervisor,
  type CoreProbe,
  type CoreSupervisorDeps,
  type SpawnedCore,
} from './index.ts';

/**
 * Машина состояний надзора ядра на поддельных часах: подъём, усыновление, отступ после
 * падения, потолок «5 за 10 минут» → `fault`, снятие зависшего подъёма, кнопка
 * «Перезапустить». Процессов здесь нет — только то, что надзор решает по ответам зависимостей.
 */

interface Harness {
  deps: CoreSupervisorDeps;
  now: () => number;
  advance(ms: number): Promise<void>;
  spawned: number[];
  killed: number[];
  ups: { pid: number; adopted: boolean }[];
  /** Что видит проба: управляет тест. */
  seen: { value: CoreProbe };
  /** Живые pid (опрос без кода выхода). */
  alive: Set<number>;
  /** Выход с кодом для своих детей (POSIX). */
  exits: Map<number, (exit: { code: number | null; signal: string | null }) => void>;
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function harness(options: { withExit?: boolean; spawnFails?: boolean } = {}): Harness {
  let clock = 1_000_000;
  let nextPid = 100;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let timerId = 0;
  const h: Harness = {
    now: () => clock,
    spawned: [],
    killed: [],
    ups: [],
    seen: { value: { kind: 'absent', reason: 'no procs.json' } },
    alive: new Set(),
    exits: new Map(),
    advance: async (ms) => {
      const until = clock + ms;
      for (;;) {
        await flush();
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > until) break;
        timers.shift();
        clock = due.at;
        due.fn();
      }
      clock = until;
      await flush();
    },
    deps: undefined as unknown as CoreSupervisorDeps,
  };
  h.deps = {
    probe: async () => h.seen.value,
    spawn: async (): Promise<SpawnedCore> => {
      if (options.spawnFails) throw new Error('node is gone');
      nextPid += 1;
      const pid = nextPid;
      h.spawned.push(pid);
      h.alive.add(pid);
      if (!options.withExit) return { pid };
      const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
        h.exits.set(pid, done),
      );
      return { pid, exited };
    },
    alive: (pid) => h.alive.has(pid),
    kill: (pid) => {
      h.killed.push(pid);
      h.alive.delete(pid);
    },
    logTail: () => ['boom: config.json is broken', 'token ••••••'],
    onUp: (pid, adopted) => h.ups.push({ pid, adopted }),
    autostart: () => 'off',
    log: () => undefined,
    now: () => clock,
    timers: {
      set: (fn, ms) => {
        timerId += 1;
        timers.push({ at: clock + ms, fn, id: timerId });
        return timerId;
      },
      clear: (handle) => {
        const at = timers.findIndex((t) => t.id === handle);
        if (at >= 0) timers.splice(at, 1);
      },
    },
    readyMs: 15_000,
    pollMs: 1_000,
  };
  return h;
}

/** Ядро поднялось: проба видит строку с этим pid. */
const upAs = (h: Harness, pid: number) => {
  h.seen.value = { kind: 'up', pid };
};
/** Ядро умерло: процесса нет, строка уже не подтверждается. */
const crash = (h: Harness, pid: number) => {
  h.alive.delete(pid);
  h.seen.value = { kind: 'absent', reason: `core pid ${pid} is gone` };
};

describe('core supervisor: ensureCore', () => {
  it('adopts a live verified core and spawns nothing', async () => {
    const h = harness();
    upAs(h, 42);
    h.alive.add(42);
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    expect(h.spawned).toEqual([]);
    expect(sup.status()).toMatchObject({ state: 'up', pid: 42, restarts: 0 });
    expect(h.ups).toEqual([{ pid: 42, adopted: true }]);
  });

  it('no core in the home → spawns one and is up once the probe sees that pid', async () => {
    const h = harness();
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    expect(h.spawned).toEqual([101]);
    expect(sup.status().state).toBe('starting');
    upAs(h, 101);
    await h.advance(1_000);
    expect(sup.status()).toMatchObject({ state: 'up', pid: 101 });
    expect(h.ups).toEqual([{ pid: 101, adopted: false }]);
  });

  it('an unverified row of a live process is waited for, not doubled', async () => {
    const h = harness();
    h.seen.value = { kind: 'unverified', pid: 77, reason: 'port not listening yet' };
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(5_000);
    expect(h.spawned).toEqual([]);
    upAs(h, 77);
    await h.advance(1_000);
    expect(h.spawned).toEqual([]);
    expect(sup.status()).toMatchObject({ state: 'up', pid: 77 });
  });
});

describe('core supervisor: restart on crash with backoff', () => {
  it('a crashed core is restarted after 1 s, a second crash waits 2 s (backoff)', async () => {
    const h = harness();
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    upAs(h, 101);
    await h.advance(1_000);
    crash(h, 101);
    await h.advance(1_000);
    expect(sup.status()).toMatchObject({ state: 'restarting', restarts: 1, pid: null });
    expect(sup.status().nextRetryAt).not.toBeNull();
    await h.advance(999);
    expect(h.spawned).toEqual([101]);
    await h.advance(1);
    expect(h.spawned).toEqual([101, 102]);
    upAs(h, 102);
    await h.advance(1_000);
    expect(sup.status().state).toBe('up');
    crash(h, 102);
    await h.advance(1_000);
    // Вторая неудача подряд: отступ 2 с, не 1.
    await h.advance(1_000);
    expect(h.spawned).toEqual([101, 102]);
    await h.advance(1_000);
    expect(h.spawned).toEqual([101, 102, 103]);
  });

  it('backoff doubles from 1 s and stops at 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(coreBackoffMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });

  it('records the exit code and the masked log tail of the crashed run', async () => {
    const h = harness({ withExit: true });
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    upAs(h, 101);
    await h.advance(1_000);
    h.exits.get(101)?.({ code: 3, signal: null });
    await h.advance(0);
    const status = sup.status();
    expect(status.state).toBe('restarting');
    expect(status.lastExit).toMatchObject({ code: 3, signal: null });
    expect(status.logTail).toEqual(['boom: config.json is broken', 'token ••••••']);
  });

  it('Windows road (no exit handle): the code comes from the core’s own exit record for that pid only', async () => {
    const h = harness();
    const asked: number[] = [];
    h.deps.exitRecord = (pid) => {
      asked.push(pid);
      return pid === 101 ? { code: 1, signal: null } : null;
    };
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    upAs(h, 101);
    await h.advance(1_000);
    crash(h, 101);
    await h.advance(1_000);
    expect(asked).toEqual([101]);
    expect(sup.status().lastExit).toMatchObject({ code: 1, signal: null });
    // Следующее ядро умерло, а итога для его pid нет — кода нет, чужой (101) не подставлен.
    await h.advance(1_000);
    upAs(h, 102);
    await h.advance(1_000);
    crash(h, 102);
    await h.advance(1_000);
    expect(asked).toEqual([101, 102]);
    expect(sup.status().lastExit).toMatchObject({ code: null, signal: null });
  });

  it('a spawned core that never gets ready is killed after the ready window and counted', async () => {
    const h = harness();
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(14_000);
    expect(h.killed).toEqual([]);
    await h.advance(1_000);
    expect(h.killed).toEqual([101]);
    expect(sup.status()).toMatchObject({ state: 'restarting', restarts: 1 });
  });
});

describe('core supervisor: fault after 5 failures in 10 minutes', () => {
  async function crashLoop(h: Harness, times: number) {
    for (let i = 0; i < times; i += 1) {
      await h.advance(61_000);
      const pid = h.spawned.at(-1);
      if (pid !== undefined) crash(h, pid);
      await h.advance(1_000);
    }
  }

  it('the fifth failure inside the window is a fault: no more spawns until «Restart»', async () => {
    const h = harness();
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    // Ядро падает на загрузке: процесс умирает раньше строки.
    await crashLoop(h, 5);
    expect(sup.status()).toMatchObject({ state: 'fault', restarts: 5, nextRetryAt: null });
    const spawnedAtFault = h.spawned.length;
    await h.advance(30 * 60_000);
    expect(h.spawned.length).toBe(spawnedAtFault);
    expect(await sup.whenUp(10)).toBe(false);
    // Кнопка «Перезапустить»: счёт с нуля, подъём сразу.
    const after = sup.restart();
    expect(after.restarts).toBe(0);
    await h.advance(0);
    expect(h.spawned.length).toBe(spawnedAtFault + 1);
  });

  it('failures spread wider than the window never reach the fault', async () => {
    const h = harness();
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    for (let i = 0; i < 8; i += 1) {
      const pid = h.spawned.at(-1);
      if (pid === undefined) throw new Error('nothing spawned');
      upAs(h, pid);
      await h.advance(1_000);
      expect(sup.status().state).toBe('up');
      // Каждое падение — через три минуты работы: за десять минут их не больше четырёх.
      await h.advance(CORE_FAULT_WINDOW_MS / 3);
      crash(h, pid);
      // Прожило дольше минуты — отступ снова 1 с: новый подъём через опрос + секунду.
      await h.advance(2_000);
      expect(h.spawned.at(-1)).not.toBe(pid);
    }
    expect(sup.status().state).not.toBe('fault');
    expect(sup.status().restarts).toBeLessThan(5);
  });

  it('a spawn that throws counts as a failure and reaches the fault too', async () => {
    const h = harness({ spawnFails: true });
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(2 * 60_000);
    expect(sup.status().state).toBe('fault');
  });
});

describe('core supervisor: the home is held by another core (second panel, stage 10)', () => {
  it('own core exits «home busy» before ready (POSIX exit code) → adopts the winner, no failure', async () => {
    const h = harness({ withExit: true });
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    expect(h.spawned).toEqual([101]);
    // Другая панель подняла своё ядро (pid 900) раньше: наше уходит на замке дома.
    h.alive.add(900);
    upAs(h, 900);
    h.alive.delete(101);
    h.exits.get(101)?.({ code: CORE_HOME_BUSY_EXIT, signal: null });
    await h.advance(1_000);
    expect(sup.status()).toMatchObject({ state: 'up', pid: 900, restarts: 0, lastExit: null });
    expect(h.ups).toEqual([{ pid: 900, adopted: true }]);
    expect(h.spawned).toEqual([101]);
  });

  it('Windows road: «home busy» read from the core’s own exit record, the winner adopted', async () => {
    const h = harness();
    h.deps.exitRecord = (pid) => (pid === 101 ? { code: CORE_HOME_BUSY_EXIT, signal: null } : null);
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    h.alive.delete(101);
    h.alive.add(900);
    h.seen.value = { kind: 'unverified', pid: 900, reason: 'port not listening yet' };
    await h.advance(1_000);
    expect(sup.status()).toMatchObject({ state: 'starting', restarts: 0 });
    upAs(h, 900);
    await h.advance(2_000);
    expect(sup.status()).toMatchObject({ state: 'up', pid: 900, restarts: 0 });
    expect(h.spawned).toEqual([101]);
  });

  it('the holder never gets ready → after the ready window «home busy» counts as a failure', async () => {
    const h = harness({ withExit: true });
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    // Держатель замка жив, но не отвечает: ни строки, ни порта.
    const busy = async () => {
      const pid = h.spawned.at(-1);
      if (pid === undefined) throw new Error('nothing spawned');
      h.alive.delete(pid);
      h.exits.get(pid)?.({ code: CORE_HOME_BUSY_EXIT, signal: null });
      await h.advance(1_000);
    };
    await busy();
    expect(sup.status()).toMatchObject({ state: 'starting', restarts: 0 });
    for (let i = 0; i < 20 && sup.status().restarts === 0; i += 1) await busy();
    expect(sup.status()).toMatchObject({ restarts: 1, lastExit: { code: CORE_HOME_BUSY_EXIT } });
    // Срок — срок подъёма (15 с), не первая же попытка и не бесконечный круг.
    expect(h.spawned.length).toBeGreaterThan(5);
    expect(h.spawned.length).toBeLessThan(20);
  });

  it('a crash with the same code AFTER the core was up is a crash, not «home busy»', async () => {
    const h = harness({ withExit: true });
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    upAs(h, 101);
    await h.advance(1_000);
    crash(h, 101);
    h.exits.get(101)?.({ code: CORE_HOME_BUSY_EXIT, signal: null });
    await h.advance(0);
    expect(sup.status()).toMatchObject({ state: 'restarting', restarts: 1 });
  });
});

describe('core supervisor: waiting and stopping', () => {
  it('whenUp resolves true once the spawned core is up', async () => {
    const h = harness();
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    const waiting = sup.whenUp(60_000);
    upAs(h, 101);
    await h.advance(1_000);
    expect(await waiting).toBe(true);
  });

  it('stop() leaves the core alone and spawns nothing more', async () => {
    const h = harness();
    const sup = createCoreSupervisor(h.deps);
    sup.start();
    await h.advance(0);
    upAs(h, 101);
    await h.advance(1_000);
    sup.stop();
    crash(h, 101);
    await h.advance(120_000);
    expect(h.spawned).toEqual([101]);
    expect(h.killed).toEqual([]);
  });
});
