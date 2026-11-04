import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { createLivenessProbe, identityOfPid } from '../platform/process-identity.ts';
import { acquireTaskLease, STALE_MS, type LeaseDeps } from './lease.ts';
import { TASK_FILES } from './journal.types.ts';
import { identity, tempDir } from './__fixtures__/journal-harness.ts';

/**
 * Перехват аренды у ДОКАЗАННО мёртвого держателя (решение координатора 03.11, 01 §Lease): та же
 * машина и зонд ОС говорит «мёртв» (pid исчез или занят другим процессом — старт не тот) —
 * аренда берётся сразу, без 15 с молчания. Иначе (другая машина, запись без `host`) — прежнее
 * правило: молчит 15 с И мёртв. Живой держатель не отдаёт аренду никогда. Жизнь судит настоящий
 * зонд платформы (`createLivenessProbe`) по настоящим процессам, подменено только время.
 */

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

async function sleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
  return child;
}

async function startOf(pid: number): Promise<string> {
  const id = await identityOfPid(pid);
  if (!('value' in id)) throw new Error(`identity of ${pid} unknown`);
  return id.value.start;
}

const probe = createLivenessProbe();
const real = (now: () => number = Date.now, extra: Partial<LeaseDeps> = {}): LeaseDeps => ({
  isAlive: (id) => probe.isAlive(id),
  now,
  ...extra,
});

async function holding(dir: string, pid: number, pidStart: string, extra: Partial<LeaseDeps> = {}) {
  const got = await acquireTaskLease(dir, identity({ pid, pidStart }), real(Date.now, extra));
  if (!got.ok) throw new Error(got.reason);
  return got.lease;
}

describe('lease takeover when the holder is PROVEN dead on this host', () => {
  it('the record carries the host, so a later contender can tell «this machine» from another', async () => {
    const dir = tempDir('proven-');
    const lease = await holding(dir, process.pid, 'start-self');
    const owner = JSON.parse(readFileSync(join(dir, TASK_FILES.owner), 'utf8')) as {
      host?: string;
    };
    expect(owner.host).toBe(hostname());
    lease.release();
  });

  it('holder pid gone (killed core), beat just now: taken at once, no 15 s silence', async () => {
    const dir = tempDir('proven-');
    const child = await sleeper();
    const pid = child.pid!;
    const holder = await holding(dir, pid, await startOf(pid));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) =>
      child.exitCode !== null || child.signalCode !== null
        ? resolve()
        : child.once('exit', () => resolve()),
    );
    // Удар держателя только что — молчания нет, решает доказанная смерть.
    holder.beat();
    const taken = await acquireTaskLease(dir, identity(), real());
    expect(taken).toMatchObject({ ok: true });
    if (taken.ok) {
      expect(taken.lease.takeoverOf).toBe(holder.leaseId);
      taken.lease.release();
    }
  }, 30_000);

  it('pid reused by another process (start differs from the record): proven dead, taken at once', async () => {
    const dir = tempDir('proven-');
    // pid живой (этот процесс), но старт в записи — чужой: держатель давно умер, pid занят заново.
    const holder = await holding(dir, process.pid, 'start-of-a-long-dead-core');
    holder.beat();
    const taken = await acquireTaskLease(dir, identity(), real());
    expect(taken).toMatchObject({ ok: true });
    if (taken.ok) {
      expect(taken.lease.takeoverOf).toBe(holder.leaseId);
      taken.lease.release();
    }
  }, 30_000);

  it('a LIVE holder on this host keeps its lease: at once and after 15 s of silence alike', async () => {
    const dir = tempDir('proven-');
    const child = await sleeper();
    const holder = await holding(dir, child.pid!, await startOf(child.pid!));
    expect(await acquireTaskLease(dir, identity(), real())).toMatchObject({
      ok: false,
      reason: 'held',
    });
    const silent = () => Date.now() + STALE_MS + 60_000;
    expect(await acquireTaskLease(dir, identity(), real(silent))).toMatchObject({
      ok: false,
      reason: 'held',
    });
    expect(JSON.parse(readFileSync(join(dir, TASK_FILES.owner), 'utf8'))).toMatchObject({
      leaseId: holder.leaseId,
    });
  }, 30_000);

  it('another host: its pid means nothing here — fallback, kept while beating, taken after 15 s silent + dead', async () => {
    const dir = tempDir('proven-');
    const T0 = 1_760_000_000_000;
    const dead = (now: number, extra: Partial<LeaseDeps> = {}): LeaseDeps => ({
      isAlive: async () => 'dead',
      now: () => now,
      ...extra,
    });
    const got = await acquireTaskLease(
      dir,
      identity({ pid: process.pid + 5 }),
      dead(T0, { host: 'other-machine' }),
    );
    if (!got.ok) throw new Error(got.reason);
    expect(await acquireTaskLease(dir, identity(), dead(T0 + STALE_MS - 1_000))).toMatchObject({
      ok: false,
      reason: 'held',
    });
    const taken = await acquireTaskLease(dir, identity(), dead(T0 + STALE_MS + 1_000));
    expect(taken).toMatchObject({ ok: true });
    if (taken.ok) taken.lease.release();
  });

  it('a record written before 03.11 (no host): fallback, a dead holder that beat recently is kept', async () => {
    const dir = tempDir('proven-');
    const T0 = 1_760_000_000_000;
    writeFileSync(
      join(dir, TASK_FILES.owner),
      JSON.stringify({ ...identity({ pid: process.pid + 6 }), leaseId: newId(), acquiredAt: T0 }),
    );
    const dead = (now: number): LeaseDeps => ({ isAlive: async () => 'dead', now: () => now });
    expect(await acquireTaskLease(dir, identity(), dead(T0 + 1_000))).toMatchObject({
      ok: false,
      reason: 'held',
    });
    const taken = await acquireTaskLease(dir, identity(), dead(T0 + STALE_MS + 1_000));
    expect(taken).toMatchObject({ ok: true });
    if (taken.ok) taken.lease.release();
  });
});
