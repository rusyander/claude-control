import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquire, slotsOf } from '../../../../../../tools/heavy-queue-hook.mjs';
import { heavySlots } from '../ChatRunner/ChatRunner.ts';
import {
  releaseSessionLeases,
  sessionHoldsLease,
  writeHeavyQueueConfig,
} from './heavy-queue-leases.ts';

const dirs: string[] = [];
const queueDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-leases-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Журнал 19.10 20:01: остановленная группа держала место очереди полчаса.
 * Аренды пишет настоящий хук (`acquire`) — формат проверяется по нему, не по копии.
 */
describe('releaseSessionLeases', () => {
  it('снимает аренды закончившейся сессии и не трогает чужие', async () => {
    const dir = queueDir();
    const call = (session: string, id: string) => ({
      session_id: session,
      tool_use_id: id,
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/check_frontend_tests.mjs', timeout: 1_800_000 },
    });
    process.env.AGENTDECK_HEAVY_SLOTS = '2';
    try {
      expect(await acquire(dir, call('dead', 'toolu_a'))).not.toBeNull();
      expect(await acquire(dir, call('alive', 'toolu_b'))).not.toBeNull();
    } finally {
      delete process.env.AGENTDECK_HEAVY_SLOTS;
    }
    expect(readdirSync(join(dir, 'leases'))).toHaveLength(2);

    expect(releaseSessionLeases(dir, 'dead')).toBe(1);
    expect(readdirSync(join(dir, 'leases'))).toEqual(['alive.toolu_b.json']);
  });

  /**
   * Журнал 19.10 20:25–20:40: мест подняли до четырёх, а группы, запущенные раньше,
   * держали два из своего окружения. Файл панели сильнее окружения группы.
   */
  it('число мест из файла панели доходит до хука поверх окружения группы', async () => {
    const dir = queueDir();
    mkdirSync(join(dir, 'leases'));
    for (const id of ['a', 'b', 'c']) {
      writeFileSync(
        join(dir, 'leases', `f${id}.toolu_${id}.json`),
        JSON.stringify({ session: `f${id}`, until: Date.now() + 600_000 }),
      );
    }
    expect(writeHeavyQueueConfig(dir, 4)).toBe(true);
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{\n  "slots": 4\n}\n');
    process.env.AGENTDECK_HEAVY_SLOTS = '2';
    process.env.AGENTDECK_HEAVY_MAX_WAIT_MS = '1500';
    try {
      const call = {
        session_id: 'mine',
        tool_use_id: 'toolu_m',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
      };
      expect(await acquire(dir, call)).not.toBeNull();
    } finally {
      delete process.env.AGENTDECK_HEAVY_SLOTS;
      delete process.env.AGENTDECK_HEAVY_MAX_WAIT_MS;
    }
    expect(slotsOf(dir)).toBe(4);
  });

  it('число мест: своё из окружения панели, иначе четверть ядер, но не меньше двух', () => {
    const cores = Math.max(2, Math.floor(availableParallelism() / 4));
    expect(heavySlots({ AGENTDECK_HEAVY_SLOTS: '3' })).toBe(3);
    expect(heavySlots({})).toBe(cores);
    expect(heavySlots({ AGENTDECK_HEAVY_SLOTS: 'x' })).toBe(cores);
    expect(writeHeavyQueueConfig(queueDir(), 0)).toBe(false);
  });

  it('без каталога, без сессии и на битом файле — ничего не снято и не падает', () => {
    const dir = queueDir();
    expect(releaseSessionLeases(dir, 'x')).toBe(0);
    mkdirSync(join(dir, 'leases'));
    writeFileSync(join(dir, 'leases', 'x.broken.json'), '{');
    expect(releaseSessionLeases(dir, 'x')).toBe(0);
    expect(releaseSessionLeases(dir, '')).toBe(0);
    expect(readdirSync(join(dir, 'leases'))).toEqual(['x.broken.json']);
  });
});

/** Сторож групп глушит R1, пока сессия держит аренду; истёкшая аренда убитого CLI глушить не должна. */
describe('sessionHoldsLease', () => {
  it('живая аренда держит, истёкшая — нет, чужая — нет', async () => {
    const dir = queueDir();
    process.env.AGENTDECK_HEAVY_SLOTS = '2';
    try {
      expect(
        await acquire(dir, {
          session_id: 'run',
          tool_use_id: 'toolu_a',
          tool_name: 'Bash',
          tool_input: { command: 'node scripts/check_frontend_tests.mjs', timeout: 600_000 },
        }),
      ).not.toBeNull();
    } finally {
      delete process.env.AGENTDECK_HEAVY_SLOTS;
    }
    const [name] = readdirSync(join(dir, 'leases'));
    const lease = JSON.parse(readFileSync(join(dir, 'leases', name ?? ''), 'utf8')) as {
      until: number;
    };
    expect(sessionHoldsLease(dir, 'run', lease.until - 1)).toBe(true);
    expect(sessionHoldsLease(dir, 'run', lease.until + 1)).toBe(false);
    expect(sessionHoldsLease(dir, 'other', lease.until - 1)).toBe(false);
    expect(sessionHoldsLease(dir, '', lease.until - 1)).toBe(false);
  });
});
