import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Очередь тяжёлых шагов под занятыми файлами. На Windows `rename`, `unlink` и чтение
 * отдают EPERM/EBUSY, пока файл держит сосед (антивирус, читатель, удаляющий): под
 * нагрузкой гейта ожидающая группа ловила такой сбой посреди ожидания и шла мимо
 * очереди — `error:EPERM` в bypass.log, 1 из 60 в пробе (I-11). Подменена только
 * граница — файловая система: сбой на выбранном пути; ожидание и аренды — настоящие.
 */
const faults = vi.hoisted(() => ({
  /** Сколько раз `rename` в аренду ещё упадёт. */
  renameLease: 0,
  /** Сколько раз удаление файла с этим именем ещё упадёт. */
  rm: new Map<string, number>(),
  /** Сколько раз чтение файла с этим именем ещё упадёт. */
  read: new Map<string, number>(),
}));

const busy = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
const take = (counts: Map<string, number>, path: unknown) => {
  const name = String(path).split(/[\\/]/).pop() ?? '';
  const left = counts.get(name) ?? 0;
  if (left <= 0) return false;
  counts.set(name, left - 1);
  return true;
};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (/[\\/]leases[\\/]/.test(String(to)) && faults.renameLease > 0) {
        faults.renameLease -= 1;
        throw busy();
      }
      return actual.renameSync(from, to);
    },
    rmSync: (path: string, options?: nodeFs.RmOptions) => {
      if (take(faults.rm, path)) throw busy();
      return actual.rmSync(path, options);
    },
    readFileSync: ((path: nodeFs.PathOrFileDescriptor, options?: unknown) => {
      if (typeof path === 'string' && take(faults.read, path)) throw busy();
      return actual.readFileSync(path, options as BufferEncoding);
    }) as typeof actual.readFileSync,
  };
});

const HOOK = resolve(__dirname, '../../../../../../tools/heavy-queue-hook.mjs');
type Input = { session_id: string; tool_use_id: string; tool_input: { command: string } };
const { acquire, finish } = (await import(pathToFileURL(HOOK).href)) as {
  acquire: (dir: string, input: Input) => Promise<number | null>;
  finish: (dir: string, input: Input & { hook_event_name: string }) => void;
};

const input = (session: string, id: string): Input => ({
  session_id: session,
  tool_use_id: id,
  tool_input: { command: 'pnpm test' },
});
const leaseNames = () => nodeFs.readdirSync(join(dir, 'leases')).filter((n) => n.endsWith('.json'));
const writeLease = (name: string, session: string, until: number) => {
  nodeFs.mkdirSync(join(dir, 'leases'), { recursive: true });
  nodeFs.writeFileSync(join(dir, 'leases', name), JSON.stringify({ session, until }));
};

let dir: string;
beforeEach(() => {
  dir = nodeFs.mkdtempSync(join(tmpdir(), 'cc-heavyq-busy-'));
  faults.renameLease = 0;
  faults.rm.clear();
  faults.read.clear();
  vi.stubEnv('AGENTDECK_HEAVY_POLL_MS', '10');
});
afterEach(() => {
  vi.unstubAllEnvs();
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

describe('heavy-queue-hook: занятые файлы ожидание не рвут', () => {
  it('аренда, занятая при записи дольше повторов записи, берётся на следующем опросе', async () => {
    // 15 > 10 попыток одной записи: прежде ожидание падало и команда шла без аренды.
    faults.renameLease = 15;
    const waited = await acquire(dir, input('s1', 'toolu_w'));
    expect(waited).not.toBeNull();
    expect(leaseNames()).toEqual(['s1.toolu_w.json']);
  });

  it('чужая аренда, занятая при чтении, место держит и не удаляется как битая', async () => {
    vi.stubEnv('AGENTDECK_HEAVY_MAX_WAIT_MS', '300');
    writeLease('s9.toolu_held.json', 's9', Date.now() + 60_000);
    faults.read.set('s9.toolu_held.json', 3);
    // Место занято всё ожидание — уход по сроку, без своей аренды.
    expect(await acquire(dir, input('s1', 'toolu_w'))).toBeNull();
    expect(leaseNames()).toEqual(['s9.toolu_held.json']);
  });

  it('протухшая аренда, которую не дали убрать, ожидание не рвёт и места не держит', async () => {
    writeLease('s9.toolu_old.json', 's9', Date.now() - 1_000);
    faults.rm.set('s9.toolu_old.json', 2);
    expect(await acquire(dir, input('s1', 'toolu_w'))).not.toBeNull();
    // Не убранную протухшую уберёт следующий читатель; место она не держала.
    expect(leaseNames().sort()).toEqual(['s1.toolu_w.json', 's9.toolu_old.json']);
  });

  it('каталог, занятый насовсем, держит не дольше терпения, а не всё ожидание', async () => {
    vi.stubEnv('AGENTDECK_HEAVY_TRANSIENT_MS', '200');
    faults.renameLease = Number.POSITIVE_INFINITY;
    const started = Date.now();
    await expect(acquire(dir, input('s1', 'toolu_w'))).rejects.toMatchObject({ code: 'EPERM' });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('конец команды отдаёт аренду, даже если удаление сначала занято', () => {
    writeLease('s1.toolu_done.json', 's1', Date.now() + 60_000);
    faults.rm.set('s1.toolu_done.json', 3);
    finish(dir, { ...input('s1', 'toolu_done'), hook_event_name: 'PostToolUse' });
    expect(leaseNames()).toEqual([]);
  });
});
