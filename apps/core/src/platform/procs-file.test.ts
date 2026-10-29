import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import {
  findCore,
  readProcs,
  registerCore,
  verifyCoreEntry,
  type ProcEntry,
} from './procs-file.ts';
import type { TcpEntry } from './tcp-table.ts';

function entry(over: Partial<ProcEntry> = {}): ProcEntry {
  return {
    build: 'b',
    pid: 4242,
    pidStart: 'start-4242',
    bootId: newId(),
    port: 5180,
    url: 'http://127.0.0.1:5180',
    startedAt: 1,
    home: '/core-home',
    portDecision: { rejected: [] },
    ...over,
  };
}

function deps(isAlive: () => Promise<'alive' | 'dead' | 'unknown'> = async () => 'alive') {
  return {
    isAlive,
    me: {
      leaseId: newId(),
      pid: process.pid,
      pidStart: 'start-self',
      bootId: newId(),
      build: 'b',
      acquiredAt: Date.now(),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('F-29 procs.json lock — a crashed holder is outwaited, boot does not fail', () => {
  it('F-29 a fresh lock left by a dead core is taken over once it falls silent (wait ≥ stale threshold)', async () => {
    const dir = tempDir('procs-lock-');
    const path = join(dir, 'procs.json');
    writeFileSync(
      `${path}.lock`,
      JSON.stringify({ leaseId: 'dead-lease', pid: 999_999, pidStart: 'gone', bootId: 'x' }),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const done = registerCore(
      path,
      entry(),
      deps(async () => 'dead'),
    ).then(
      (file) => ({ file }),
      (error: unknown) => ({ error: String(error) }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await done;
    expect(outcome).toHaveProperty('file');
  });
});

describe('F-54 procs.json rows from another build — extra fields kept, not a broken file', () => {
  it('F-54 an unknown field on a core row → findCore still answers and registerCore keeps the field', async () => {
    const dir = tempDir('procs-loose-');
    const path = join(dir, 'procs.json');
    const other = {
      ...entry({ bootId: 'other', port: 5181, url: 'http://127.0.0.1:5181' }),
      extra: 1,
    };
    writeFileSync(path, JSON.stringify({ v: 1, cores: [other], servers: [], future: true }));
    const found = findCore(path);
    expect('value' in found && found.value.length).toBe(1);
    await registerCore(path, entry(), deps());
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { cores: Record<string, unknown>[] };
    expect(raw.cores.find((c) => c.bootId === 'other')?.extra).toBe(1);
  });
});

describe('F-19 procs.json readers — a session bearer goes only to a loopback core that owns its port', () => {
  it('F-19 rows with a non-loopback URL or a URL port other than the row port are dropped on read', () => {
    const dir = tempDir('procs-url-');
    const path = join(dir, 'procs.json');
    const good = entry();
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        cores: [
          entry({ bootId: 'evil', url: 'http://attacker.example:5180' }),
          entry({ bootId: 'lan', url: 'http://192.168.1.10:5180' }),
          entry({ bootId: 'port', url: 'http://127.0.0.1:6000' }),
          entry({ bootId: 'cred', url: 'http://user@127.0.0.1:5180' }),
          good,
          entry({ bootId: 'v6', url: 'http://[::1]:5180/' }),
        ],
        servers: [],
      }),
    );
    const read = readProcs(path);
    expect('value' in read && read.value.cores.map((c) => c.bootId)).toEqual([good.bootId, 'v6']);
  });

  it('F-19 identity: the loopback listener on the row port must be the row pid, alive with its start', async () => {
    const listen = (pid: number, address = '127.0.0.1'): TcpEntry => ({
      state: 'listen',
      localAddress: address,
      localPort: 5180,
      remoteAddress: '0.0.0.0',
      remotePort: 0,
      pid,
    });
    const good = entry();
    const alive = async () => 'alive' as const;
    expect(
      await verifyCoreEntry(good, { tcp: async () => ({ value: [listen(4242)] }), isAlive: alive }),
    ).toEqual({
      value: true,
    });
    expect(
      await verifyCoreEntry(good, {
        tcp: async () => ({ value: [listen(31337)] }),
        isAlive: alive,
      }),
    ).toMatchObject({ unknown: expect.stringContaining('31337') });
    expect(
      await verifyCoreEntry(good, {
        tcp: async () => ({ value: [listen(4242)] }),
        isAlive: async () => 'dead',
      }),
    ).toMatchObject({ unknown: expect.stringContaining('dead') });
    expect(
      await verifyCoreEntry(good, { tcp: async () => ({ unknown: 'no table' }), isAlive: alive }),
    ).toMatchObject({ unknown: expect.stringContaining('no table') });
    expect(
      await verifyCoreEntry(entry({ url: 'http://evil.example:5180' }), {
        tcp: async () => ({ value: [listen(4242)] }),
        isAlive: alive,
      }),
    ).toMatchObject({ unknown: expect.stringContaining('loopback') });
  });
});
