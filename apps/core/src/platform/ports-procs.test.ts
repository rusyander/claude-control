import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import {
  allocatePort,
  isReserved,
  listenOnAllocatedPort,
  RESERVED_PORTS,
  type BindProbe,
} from './ports.ts';
import {
  findCore,
  registerCore,
  registerServer,
  unregisterCore,
  type ProcEntry,
} from './procs-file.ts';

/** Поддельная привязка: отдаёт порты по очереди; `Error` в очереди — отказ привязки. */
function scriptedBind(script: (number | Error)[]): BindProbe & { closed: number[] } {
  const closed: number[] = [];
  const bind = (async () => {
    const next = script.shift();
    if (next === undefined) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return { port: next, close: async () => void closed.push(next) };
  }) as unknown as BindProbe & { closed: number[] };
  bind.closed = closed;
  return bind;
}
const excluded = (): Error => Object.assign(new Error('bind EACCES'), { code: 'EACCES' });

function entry(build: string, port: number): ProcEntry {
  return {
    build,
    pid: process.pid,
    pidStart: 'start-self',
    bootId: newId(),
    port,
    url: `http://127.0.0.1:${port}`,
    startedAt: Date.now(),
    home: '/core-home',
    portDecision: { rejected: [] },
  };
}
function procsDeps(build: string, alive: 'alive' | 'dead' = 'alive') {
  return {
    isAlive: async () => alive,
    me: {
      leaseId: newId(),
      pid: process.pid,
      pidStart: 'start-self',
      bootId: newId(),
      build,
      acquiredAt: Date.now(),
    },
  };
}

describe('ports and procs.json', () => {
  it('P59 taken/excluded/reserved candidates are rejected with a reason and journaled; the port is free', async () => {
    const bind = scriptedBind([excluded(), 5178, 5175, 49_152]);
    const decision = await allocatePort(bind);
    expect(decision.port).toBe(49_152);
    expect(decision.rejected).toEqual([
      { port: 0, reason: 'bind failed: EACCES' },
      { port: 5178, reason: 'reserved 5170-5180' },
      { port: 5175, reason: 'reserved 5170-5180' },
    ]);
    // Отвергнутые держались до конца выбора и отпущены после.
    expect(bind.closed).toEqual(expect.arrayContaining([5178, 5175, 49_152]));

    const taken = Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
    const tried: number[] = [];
    const listened = await listenOnAllocatedPort(
      async (port) => {
        tried.push(port);
        if (tried.length === 1) throw taken;
      },
      scriptedBind([40_001, 40_002]),
    );
    expect(listened).toEqual({
      port: 40_002,
      rejected: [{ port: 40_001, reason: 'listen EADDRINUSE' }],
    });
  });

  it('P83 real loopback allocation never lands in 5170-5180; two builds get two ports, found through procs.json', async () => {
    const ports = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      const { port } = await allocatePort();
      expect(isReserved(port)).toBe(false);
      ports.add(port);
    }
    expect(RESERVED_PORTS).toEqual({ from: 5170, to: 5180 });
    const path = join(tempDir(), 'procs.json');
    const a = await allocatePort();
    const b = await allocatePort();
    expect(a.port).not.toBe(b.port);
    // Две сборки регистрируются одновременно: замок не даёт потерять строку соседа.
    await Promise.all([
      registerCore(path, entry('build-a', a.port), procsDeps('build-a')),
      registerCore(path, entry('build-b', b.port), procsDeps('build-b')),
    ]);
    const foundA = findCore(path, 'build-a');
    const foundB = findCore(path, 'build-b');
    expect('value' in foundA && foundA.value.map((c) => c.port)).toEqual([a.port]);
    expect('value' in foundB && foundB.value.map((c) => c.port)).toEqual([b.port]);
  });

  it('P83 procs.json keeps live rows, drops dead ones, refuses to overwrite a garbage file, reports garbage as unknown', async () => {
    const path = join(tempDir(), 'procs.json');
    expect(findCore(path)).toEqual({ absent: true });
    const old = entry('old', 41_000);
    await registerCore(path, old, procsDeps('old'));
    const fresh = entry('new', 41_001);
    await registerCore(path, fresh, procsDeps('new', 'dead'));
    const after = findCore(path);
    expect('value' in after && after.value.map((c) => c.build)).toEqual(['new']);
    await registerServer(
      path,
      {
        kind: 'stub-server',
        id: 's1',
        pid: process.pid,
        pidStart: 'start-self',
        port: 41_002,
        ownerBootId: fresh.bootId,
        startedAt: Date.now(),
      },
      procsDeps('new'),
    );
    await unregisterCore(path, fresh.bootId, procsDeps('new'));
    const empty = findCore(path);
    expect('value' in empty && empty.value).toEqual([]);
    writeFileSync(path, '{"v":1,"cores":"garbage"}');
    expect('unknown' in findCore(path)).toBe(true);
    await expect(registerCore(path, entry('x', 41_003), procsDeps('x'))).rejects.toThrow(
      /unreadable/,
    );
  });
});
