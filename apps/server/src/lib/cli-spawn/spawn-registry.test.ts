import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { recordSpawn, spawnRecords } from './spawn-registry.ts';

/**
 * Реестр запусков (RF-BGCD-09): добор копии снимает только записанное здесь.
 * Запись — с канала `child_process`, то есть любой запуск сервера попадает в
 * реестр сам, без вызова в месте запуска.
 */

const recordOf = (pid: number | undefined) => spawnRecords().find((item) => item.pid === pid);

describe('spawn-registry', () => {
  it('настоящий spawn записан с моментом запуска, а выход — с моментом выхода', async () => {
    const before = Date.now();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await once(child, 'spawn');
    const live = recordOf(child.pid);
    expect(live?.spawnedAt).toBeGreaterThanOrEqual(before);
    expect(live?.exitedAt).toBeUndefined();
    await once(child, 'exit');
    expect(recordOf(child.pid)?.exitedAt).toBeGreaterThanOrEqual(live?.spawnedAt ?? 0);
  });

  it('execFile идёт через тот же канал', async () => {
    let pid: number | undefined;
    await new Promise<void>((done) => {
      pid = execFile(process.execPath, ['-e', ''], () => done()).pid;
    });
    expect(recordOf(pid)).toBeDefined();
  });

  it('запуск без номера (бинарник не найден) не записывается', async () => {
    const before = spawnRecords().length;
    const child = spawn('agentdeck-no-such-binary-xyz', [], { stdio: 'ignore' });
    await once(child, 'error');
    expect(child.pid).toBeUndefined();
    expect(spawnRecords().length).toBe(before);
  });

  it('потолок вытесняет старейшие вышедшие, живые остаются', () => {
    const listeners: Array<() => void> = [];
    const fake = (pid: number) => ({
      pid,
      once: (_event: string, listener: () => void) => listeners.push(listener),
    });
    const alive = 900_000_001;
    recordSpawn(fake(alive), () => 1);
    listeners.length = 0;
    for (let index = 0; index < 4200; index += 1) {
      recordSpawn(fake(900_100_000 + index), () => 2);
      listeners.pop()?.();
    }
    const records = spawnRecords();
    expect(records.length).toBeLessThanOrEqual(4096);
    expect(records.some((item) => item.pid === alive && item.exitedAt === undefined)).toBe(true);
    expect(records.some((item) => item.pid === 900_100_000)).toBe(false);
    expect(records.some((item) => item.pid === 900_100_000 + 4199)).toBe(true);
  });
});
