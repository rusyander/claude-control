import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { hasValue } from '../../../platform/os-kind.ts';
import { createLivenessProbe } from '../../../platform/process-identity.ts';
import { liveRunnerFiles } from './__fixtures__/fake-gpu.ts';
import { stopLeaseServers } from './__fixtures__/lease-sweep.ts';
import { ownDir, ownOptions } from './__fixtures__/own-options.ts';
import { leaseDirs, readLeaseState, writeLeaseState } from './lease-state.ts';
import { createOwnRoute, type OwnRoute } from './own.ts';
import { createSlotQueue } from './slot.ts';

/**
 * Уборка тестов `local:own`: сервер аренды, брошенной красной проверкой, переживал vitest
 * (хранитель с маршрутизатором — пять пар после прогонов 28.10). Уборка снимает его по записи
 * аренды и личности; процесс с тем же номером, но другим стартом, не трогает.
 */

const base = mkdtempSync(join(tmpdir(), 'own-sweep-'));
const routes: OwnRoute[] = [];
const sleepers: ChildProcess[] = [];
const quiet: RouteRecorder = {
  decision: () => undefined,
  created: () => undefined,
  verified: () => undefined,
  leak: () => undefined,
};

afterAll(async () => {
  // Своим путём ядра, не уборкой под проверкой: сломанная уборка не оставит сервер жить.
  for (const route of routes) await route.shutdown(quiet).catch(() => undefined);
  for (const child of sleepers) if (child.exitCode === null) child.kill();
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // Windows держит каталог хранителя ещё мгновение — временный каталог ОС уберёт сама.
  }
}, 120_000);

describe('own route test sweep — a lease left by a red check does not outlive the test file', () => {
  it('stops the held server tree (keeper, router, runners) by the lease record; a same-pid process with another start stays', async () => {
    const probe = createLivenessProbe();
    const layout = ownDir(mkdtempSync(join(base, 'held-')));
    const route = createOwnRoute({ ...ownOptions(layout), slots: createSlotQueue() });
    routes.push(route);
    await route.acquire({ taskId: 't', model: 'tiny-model' }, quiet);
    const [held] = leaseDirs(layout.workRoot);
    const record = held ? readLeaseState(held) : undefined;
    const server = record?.server;
    if (!record || !server) throw new Error('no server in the lease record');
    expect(await probe.isAlive(server.identity, { fresh: true })).toBe('alive');
    expect(await liveRunnerFiles(layout.vramDir)).toHaveLength(1);

    // Чужой процесс под номером из записи, но со своим стартом — номер ушёл другому.
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    sleepers.push(sleeper);
    const foreign = join(ownDir(mkdtempSync(join(base, 'foreign-'))).workRoot, 'L-foreign');
    mkdirSync(foreign, { recursive: true });
    writeLeaseState(foreign, {
      ...record,
      leaseId: 'L-foreign',
      server: {
        ...server,
        identity: { pid: sleeper.pid ?? 0, start: 'another start' },
        marker: 'L-foreign-marker',
      },
    });

    await stopLeaseServers(base);

    expect(await probe.isAlive(server.identity, { fresh: true })).toBe('dead');
    expect(await liveRunnerFiles(layout.vramDir)).toEqual([]);
    const sleeperId = await probe.identityOf(sleeper.pid ?? 0);
    expect(hasValue(sleeperId) && (await probe.isAlive(sleeperId.value, { fresh: true }))).toBe(
      'alive',
    );
  }, 60_000);
});
