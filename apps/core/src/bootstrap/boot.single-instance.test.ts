import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_BUSY_EXIT_ENV } from '@agentdeck/contracts/core/supervisor';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../hop-host/__fixtures__/hop-stand.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { identityOfPid } from '../platform/process-identity.ts';
import { bootCore, CoreHomeBusy } from './boot.ts';
import type { BootedCore } from './boot/boot.types.ts';

/**
 * Одно ядро на дом (дефект s10): без замка второе ядро вставало рядом с первым — два писателя
 * одних журналов задач и две строки в procs.json. Замок `<home>/core.lock`; держатель мёртв ⇒
 * замок перехватывается сразу, жив ⇒ отказ до первого побочного действия.
 */

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');
const open: BootedCore[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const core of open.splice(0)) await core.stop();
  for (const child of children.splice(0)) child.kill();
});

async function sleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
  return child;
}

async function holderOf(child: ChildProcess): Promise<Record<string, unknown>> {
  const id = await identityOfPid(child.pid!);
  if (!('value' in id)) throw new Error('child identity unknown');
  return {
    leaseId: 'foreign-lease',
    pid: child.pid,
    pidStart: id.value.start,
    bootId: 'foreign',
    build: 'foreign',
    acquiredAt: Date.now(),
  };
}

describe('core single instance per home (core.lock)', () => {
  it('a second bootCore on the same home is refused while the first runs, and allowed after stop', async () => {
    const home = join(tempDir('core-lock-'), 'core');
    const first = await bootCore({ home, build: 'lock-1', loop: false });
    open.push(first);
    await expect(bootCore({ home, build: 'lock-2', loop: false })).rejects.toBeInstanceOf(
      CoreHomeBusy,
    );
    // Отказ не тронул первое ядро: его строка и замок на месте.
    const procs = JSON.parse(readFileSync(first.layout.procs, 'utf8')) as {
      cores?: { bootId: string }[];
    };
    expect(JSON.stringify(procs)).toContain(first.bootId);
    expect(existsSync(join(first.layout.root, 'core.lock'))).toBe(true);
    await first.stop();
    open.splice(0);
    expect(existsSync(join(first.layout.root, 'core.lock'))).toBe(false);
    const again = await bootCore({ home, build: 'lock-3', loop: false });
    open.push(again);
    expect(again.bootId).not.toBe(first.bootId);
  }, 60_000);

  it('a lock held by a live foreign process refuses the boot; the same lock of a dead pid is reclaimed', async () => {
    const home = join(tempDir('core-lock-'), 'core');
    const layout = ensureCoreHome(home);
    const lock = join(layout.root, 'core.lock');
    const child = await sleeper();
    writeFileSync(lock, JSON.stringify(await holderOf(child)), 'utf8');
    await expect(bootCore({ home, build: 'lock-live', loop: false })).rejects.toThrow(
      /core already running for this home/,
    );
    child.kill();
    await new Promise<void>((resolve) =>
      child.exitCode !== null ? resolve() : child.once('exit', () => resolve()),
    );
    const core = await bootCore({ home, build: 'lock-dead', loop: false });
    open.push(core);
    const held = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; bootId: string };
    expect(held.pid).toBe(process.pid);
    expect(held.bootId).toBe(core.bootId);
  }, 60_000);

  it('a real second core process on the same home exits 3 and names the holder', async () => {
    const home = join(tempDir('core-lock-'), 'core');
    const first = await bootCore({ home, build: 'lock-proc', loop: false });
    open.push(first);
    const env = { ...process.env };
    delete env.VITEST;
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', ENTRY, '--home', first.layout.root],
      { cwd: join(dirname(ENTRY), '..'), env, encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('core already running for this home');
    expect(run.stderr).toContain(String(process.pid));
  }, 90_000);

  it('under OS autostart (AGENTDECK_CORE_BUSY_EXIT=0) the second core exits 0, so systemd/launchd do not respawn it', async () => {
    const home = join(tempDir('core-lock-'), 'core');
    const first = await bootCore({ home, build: 'lock-autostart', loop: false });
    open.push(first);
    const env: NodeJS.ProcessEnv = { ...process.env, [CORE_BUSY_EXIT_ENV]: '0' };
    delete env.VITEST;
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', ENTRY, '--home', first.layout.root],
      { cwd: join(dirname(ENTRY), '..'), env, encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('core already running for this home');
  }, 90_000);
});
