import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { profileWiring } from '../../bootstrap/verifier-wiring/profile.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { realMachineIo } from '../../platform/machine.ts';
import type { MachineIo } from '../../platform/machine.types.ts';
import {
  machineProbes,
  runPreflight,
  type PreflightProbes,
  type Road,
  type RoadOutcome,
} from './index.ts';
import { realLsRemote } from './probes.ts';

/**
 * Предполётная проверка (04:105-112, P101): настоящие пробы ядра — привязка к 127.0.0.1, чтение
 * временного репозитория, `git ls-remote` к настоящему голому репозиторию, диск тома temp; пробы
 * чужих зон (CLI, маршрут, MCP ядра, захват, движок) — вставленные. Каждая сломанная дорога —
 * задача не стартует, дорога и исправление названы; мало диска — ни новой копии, ни контейнера.
 */

const scratch = mkdtempSync(join(tmpdir(), 'agentdeck-core-preflight-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const repoPath = join(scratch, 'repo');
const bare = join(scratch, 'origin.git');
mkdirSync(repoPath);
execFileSync('git', ['init', '-q', repoPath]);
execFileSync('git', ['init', '-q', '--bare', bare]);

const ok = (): Promise<RoadOutcome> => Promise.resolve({ status: 'ok' });
const foreignOk: PreflightProbes = {
  cli: ok,
  route: ok,
  'core-mcp': ok,
  capture: ok,
  'container-engine': ok,
};

const GiB = 1024 ** 3;
function diskIo(freeGiB: number, totalGiB: number): MachineIo {
  return {
    ...realMachineIo,
    statfs: async () => ({ bavail: freeGiB * GiB, blocks: totalGiB * GiB, bsize: 1 }),
  };
}

const real = (over: Partial<Parameters<typeof machineProbes>[0]> = {}) =>
  machineProbes({ repos: [{ path: repoPath, remotes: [bare] }], diskPath: scratch, ...over });

const statusOf = (roads: { road: Road; status: string }[], road: Road) =>
  roads.find((r) => r.road === road)?.status;

describe('preflight of roads (P101)', () => {
  it('all roads healthy on the real machine: start; push closure and forge read are never ok before phase 6', async () => {
    const v = await runPreflight({ needsServices: true }, { ...real(), ...foreignOk });
    expect(v.blocking).toEqual([]);
    expect(v.start).toBe(true);
    for (const road of ['ports', 'repo-access', 'ls-remote', 'disk'] as const)
      expect(statusOf(v.roads, road), road).toBe('ok');
    expect(v.roads.filter((r) => r.status === 'not-checked-until-phase')).toEqual([
      {
        road: 'push-closure',
        status: 'not-checked-until-phase',
        phase: 6,
        detail: 'arrives with publish (05)',
      },
      {
        road: 'forge-read',
        status: 'not-checked-until-phase',
        phase: 6,
        detail: 'arrives with publish (05)',
      },
    ]);
  });

  it('a remote shaped like an option is a remote, never a git flag: --upload-pack runs nothing', async () => {
    const marker = join(scratch, 'upload-pack-ran').replace(/\\/g, '/');
    const evil = `--upload-pack=node -e "require('fs').writeFileSync('${marker}','x')"`;
    // Флаг без адреса git применяет к удалённому по умолчанию — нужен репозиторий с origin.
    const withOrigin = join(scratch, 'repo-origin');
    execFileSync('git', ['init', '-q', withOrigin]);
    execFileSync('git', ['-C', withOrigin, 'remote', 'add', 'origin', bare]);
    const got = await realLsRemote(withOrigin, evil);
    expect(existsSync(marker)).toBe(false);
    expect(got).not.toEqual({ value: { code: 0 } });
  });

  it('each broken road alone stops the start and is named with its fix', async () => {
    const foreign: Road[] = ['cli', 'route', 'core-mcp', 'capture', 'container-engine'];
    for (const road of foreign) {
      const broken: RoadOutcome = { status: 'fail', detail: `${road} down`, fix: `fix ${road}` };
      const v = await runPreflight(
        { needsServices: true },
        { ...real(), ...foreignOk, [road]: async () => broken },
      );
      expect(v.start, road).toBe(false);
      expect(v.blocking, road).toEqual([{ road, ...broken }]);
    }
    const realBroken = await Promise.all([
      runPreflight(
        { needsServices: false },
        {
          ...real({ repos: [{ path: repoPath, remotes: [join(scratch, 'no-such-remote.git')] }] }),
          ...foreignOk,
        },
      ),
      runPreflight(
        { needsServices: false },
        { ...real({ repos: [{ path: join(scratch, 'gone'), remotes: [bare] }] }), ...foreignOk },
      ),
      runPreflight(
        { needsServices: false },
        {
          ...real({
            bind: async () => {
              throw Object.assign(new Error('listen EACCES 127.0.0.1'), { code: 'EACCES' });
            },
          }),
          ...foreignOk,
        },
      ),
    ]);
    expect(realBroken.map((v) => v.blocking.map((b) => `${b.road}:${b.status}`))).toEqual([
      ['ls-remote:fail'],
      ['ls-remote:fail', 'repo-access:fail'], // git -C на пропавшей папке тоже не доходит
      ['ports:fail'],
    ]);
    expect(realBroken[0]?.blocking[0]).toMatchObject({ fix: expect.stringMatching(/remote URL/) });
    expect(realBroken[1]?.blocking[1]).toMatchObject({
      detail: `repository folder missing: ${join(scratch, 'gone')}`,
    });
  });

  it('an unknown road blocks, a missing probe is unknown(not wired), a hung probe times out', async () => {
    const v = await runPreflight(
      { needsServices: 'unknown' },
      {
        ...real(),
        cli: ok,
        route: async () => ({ status: 'unknown', detail: 'credential store unreadable' }),
        'core-mcp': () => new Promise(() => undefined),
        'container-engine': ok,
      },
      { timeoutMs: 5000 },
    );
    expect(v.start).toBe(false);
    expect(v.blocking.map((b) => [b.road, b.status, 'detail' in b ? b.detail : ''])).toEqual([
      ['route', 'unknown', 'credential store unreadable'],
      ['core-mcp', 'unknown', 'probe timeout after 5000 ms'],
      ['capture', 'unknown', 'not wired: no probe for this road in this build'],
    ]);
  });

  it('the engine is skipped only when the profile needs no services', async () => {
    const without = { ...real(), cli: ok, route: ok, 'core-mcp': ok, capture: ok };
    const no = await runPreflight({ needsServices: false }, without);
    expect(no.start).toBe(true);
    expect(statusOf(no.roads, 'container-engine')).toBe('skipped');
    const unsure = await runPreflight({ needsServices: 'unknown' }, without);
    expect(unsure.blocking.map((b) => b.road)).toEqual(['container-engine']);
  });

  it('git-version: the real git passes; older than 2.38 blocks with the fix; a non-publishing scenario skips it', async () => {
    const live = await runPreflight({ needsServices: true }, { ...real(), ...foreignOk });
    expect(live.roads.find((r) => r.road === 'git-version')).toMatchObject({
      status: 'ok',
      detail: expect.stringMatching(/^git \d+\.\d+\.\d+$/),
    });
    const old = { ...real({ gitVersion: async () => ({ value: 'git version 2.37.9' }) }) };
    const blocked = await runPreflight({ needsServices: true }, { ...old, ...foreignOk });
    expect(blocked.start).toBe(false);
    expect(blocked.blocking).toEqual([
      {
        road: 'git-version',
        status: 'fail',
        detail: 'git 2.37.9 has no merge-tree --write-tree',
        fix: 'install git 2.38.0 or newer',
      },
    ]);
    const quiet = await runPreflight(
      { needsServices: true, publishes: false },
      { ...old, ...foreignOk },
    );
    expect(quiet.start).toBe(true);
    expect(statusOf(quiet.roads, 'git-version')).toBe('skipped');
    const garbled = real({ gitVersion: async () => ({ value: 'not a version' }) });
    const unsure = await runPreflight({ needsServices: true }, { ...garbled, ...foreignOk });
    expect(unsure.blocking.map((b) => [b.road, b.status])).toEqual([['git-version', 'unknown']]);
  });

  it('disk below threshold: no start and no new copies; disk unknown: start with the doubt named; low RAM lowers slots', async () => {
    const low = await runPreflight(
      { needsServices: false },
      { ...real({ io: diskIo(3, 500) }), ...foreignOk },
    );
    expect(low.start).toBe(false);
    expect(low.noNewCopies).toBe(true);
    expect(low.blocking).toEqual([
      expect.objectContaining({ road: 'disk', status: 'low', fix: expect.any(String) }),
    ]);

    const doubt = await runPreflight(
      { needsServices: false },
      {
        ...real({
          io: { ...realMachineIo, statfs: async () => Promise.reject(new Error('EIO')) },
        }),
        ...foreignOk,
      },
    );
    expect(doubt.start).toBe(true);
    expect(doubt.doubts.map((d) => [d.road, d.status])).toEqual([['disk', 'unknown']]);

    const tight = await runPreflight(
      { needsServices: false },
      {
        ...real({ io: { ...realMachineIo, memory: () => ({ free: 0.5 * GiB, total: 16 * GiB }) } }),
        ...foreignOk,
      },
    );
    expect(tight.start).toBe(true);
    expect(tight.slotsLowered).toBe(true);
    expect(tight.noNewCopies).toBe(false);
  });

  it('macOS TCC on the repo folder blocks with the privacy-settings fix', async () => {
    const tcc = await runPreflight(
      { needsServices: false },
      {
        ...real({
          os: 'darwin',
          io: {
            ...realMachineIo,
            readdir: async () =>
              Promise.reject(
                Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
              ),
          },
        }),
        ...foreignOk,
      },
    );
    expect(tcc.start).toBe(false);
    expect(tcc.blocking).toEqual([
      expect.objectContaining({
        road: 'repo-access',
        status: 'unknown',
        fix: expect.stringMatching(/Privacy & Security/),
      }),
    ]);
  });

  it('every repository of a multi-repo task is probed: folder access and ls-remote name the repo', async () => {
    const second = join(scratch, 'repo-two');
    execFileSync('git', ['init', '-q', second]);
    const v = await runPreflight(
      { needsServices: false },
      {
        ...real({
          repos: [
            { path: repoPath, remotes: [bare] },
            { path: second, remotes: [join(scratch, 'no-such-second.git')] },
            { path: join(scratch, 'gone-two'), remotes: [] },
          ],
        }),
        ...foreignOk,
      },
    );
    expect(v.start).toBe(false);
    const byRoad = Object.fromEntries(
      v.blocking.map((b) => [b.road, 'detail' in b ? b.detail : '']),
    );
    expect(byRoad['repo-access']).toBe(
      `${join(scratch, 'gone-two')}: repository folder missing: ${join(scratch, 'gone-two')}`,
    );
    expect(byRoad['ls-remote']).toContain(`${second}: ls-remote refused`);
    expect(byRoad['ls-remote']).not.toContain(`${repoPath}:`);
  });

  it('allow-list: only ok / skipped / later-phase / RAM low / resource doubt start; any other answer blocks', async () => {
    const answers: unknown[] = [
      { status: 'skipped', detail: 'x' },
      { status: 'low', detail: 'cli low' },
      { status: 'OK' },
      {},
      null,
      { status: 'not-checked-until-phase', phase: 6, detail: 'x' },
    ];
    for (const answer of answers) {
      const v = await runPreflight(
        { needsServices: false },
        { ...real(), ...foreignOk, cli: async () => answer as RoadOutcome },
      );
      expect(v.start, JSON.stringify(answer)).toBe(false);
      expect(
        v.blocking.map((b) => [b.road, b.status]),
        JSON.stringify(answer),
      ).toEqual([['cli', 'unknown']]);
    }
  });

  it('the wiring runs the core probes against the core home volume and takes foreign probes', async () => {
    const w = profileWiring({ layout: layoutOf(join(scratch, 'core-home')) });
    mkdirSync(join(scratch, 'core-home'));
    const v = await w.preflight(
      { needsServices: false, repos: [{ path: repoPath, remotes: [bare] }] },
      { cli: ok, route: ok, 'core-mcp': ok, capture: ok },
    );
    expect(v.blocking).toEqual([]);
    expect(statusOf(v.roads, 'disk')).toBe('ok');
    const unwired = await w.preflight({
      needsServices: false,
      repos: [{ path: repoPath, remotes: [] }],
    });
    expect(unwired.blocking.map((b) => b.road)).toEqual(['cli', 'route', 'core-mcp', 'capture']);
  });
});
