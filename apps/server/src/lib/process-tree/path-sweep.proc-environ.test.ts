import { describe, expect, it, vi } from 'vitest';
import { filetimeFromMs } from '../kill-tree.mjs';
import type { CommandRow } from './path-sweep.ts';

const MARK = 'AGENTDECK_TESTS_RUNS_AT_DELIVERY';
const read: string[] = [];

// Подменена только файловая система (граница ОС): хоста Linux у прогона нет, а
// `/proc/<pid>/environ` — ровно то, что добор читает на нём без явного `readEnv`.
vi.mock('node:fs', async (load) => {
  const real = await load<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const name = String(path);
    if (name.startsWith('/proc/')) {
      read.push(name);
      if (name === '/proc/30/environ') return `PATH=/usr/bin\0${MARK}=1\0`;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

const { sweepPathProcesses } = await import('./path-sweep.ts');

const at = (ms: number): bigint => filetimeFromMs(ms);
const row = (pid: number, ppid: number, command: string, created: bigint): CommandRow => ({
  pid,
  ppid,
  created,
  command,
});

/**
 * RF-BGCD-09: на Linux метка группы читается из `/proc/<pid>/environ` сама — без
 * шва `readEnv`. Без этого чтения по умолчанию сирота группы у `systemd --user`
 * снова уцелевает (обход доходит до предка сервера).
 */
describe('sweepPathProcesses: на Linux окружение читается из /proc без шва (RF-BGCD-09)', () => {
  const g0 = '/home/me/copies/g0';
  const table = [
    row(1, 0, '/sbin/init', at(10)),
    row(2, 1, '/usr/lib/systemd/systemd --user', at(20)),
    row(20, 2, '/usr/bin/gnome-terminal-server', at(100)),
    row(21, 20, 'bash', at(110)),
    row(6, 21, 'node /home/me/agentdeck/apps/server/src/index.ts', at(200)),
    row(30, 2, `node ${g0}/node_modules/vite/bin/vite.js`, at(400)),
    row(31, 2, `node ${g0}/scripts/dev.mjs`, at(410)),
  ];

  it('сирота с меткой в /proc снимается, без метки — нет', async () => {
    const sent: number[] = [];
    const killed = await sweepPathProcesses(g0, {
      platform: 'linux',
      selfPid: 6,
      mark: MARK,
      readTable: () => Promise.resolve(table),
      kill: (pid) => sent.push(pid),
    });
    expect(killed).toEqual([30]);
    expect(sent).toEqual([30]);
    expect(read).toContain('/proc/30/environ');
  });
});
