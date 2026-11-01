import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_MCP_SERVER } from '@agentdeck/contracts/core/model-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { splitEnvFor } from '../../bootstrap/conductor-wiring/split.ts';
import type { ConductorWiringDeps } from '../../bootstrap/conductor-wiring/conductor-wiring.types.ts';
import { DEFAULT_NODE_ARGV } from '../../bootstrap/session-road.ts';
import { buildVerifierWiring } from '../../bootstrap/verifier-wiring/index.ts';
import { deps as journalDeps } from '../../journal/__fixtures__/journal-harness.ts';
import { coreMcpServers } from '../../mcp/main.ts';
import { CAPTURE_SHIM } from '../../platform/capture-shim.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { createCliLoginRoute } from '../../routes/cli-login/cli-login.ts';
import { createRouteRegistry } from '../../routes/registry.ts';
import { runTaskPreflight } from '../estimate/index.ts';
import { gitRepo } from '../split/__fixtures__/split-stand.ts';
import { createTaskRegistry } from '../tasks.ts';
import {
  captureProbe,
  cliProbe,
  coreMcpProbe,
  routeProbe,
  type AllowedRoute,
  type RoadProbeInput,
} from './index.ts';

/**
 * Пробы дорог сессии (P101) над настоящим: исполняемый файл в каталоге PATH, настоящий реестр
 * маршрутов с маршрутом входа CLI, запись моста ядра дороги сессии и прокладка захвата на диске.
 * Подставлено только окружение поиска (PATH) — внешняя граница машины.
 */

let root: string;
let bin: string;

const FAKE = 'agentdeck-fake-cli';
const CLAUDE: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'cli-login', id: 'cli-login:claude' },
  modelPattern: '*',
};

/**
 * Исполняемый файл CLI в каталоге, как его ставит npm: обёртка `.cmd` над node-скриптом на
 * Windows (произвольный `.cmd` запускатель отвергает — оболочки у ядра нет), сценарий с правом
 * запуска иначе.
 */
function fakeCli(dir: string, name: string): void {
  if (process.platform === 'win32') {
    writeFileSync(join(dir, `${name}.js`), '');
    writeFileSync(
      join(dir, `${name}.cmd`),
      [
        '@SETLOCAL',
        '@IF EXIST "%~dp0\\node.exe" (',
        `  "%~dp0\\node.exe"  "%~dp0\\${name}.js" %*`,
        ') ELSE (',
        '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
        `  node  "%~dp0\\${name}.js" %*`,
        ')',
      ].join('\r\n'),
    );
  } else {
    writeFileSync(join(dir, name), '#!/bin/sh\n');
    chmodSync(join(dir, name), 0o755);
  }
}

const pathEnv = (): NodeJS.ProcessEnv => ({
  PATH: bin,
  ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-road-probes-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  fakeCli(bin, FAKE);
  fakeCli(bin, 'claude');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const run = (probe: (i: RoadProbeInput) => () => Promise<unknown>, input: RoadProbeInput) =>
  probe(input)();

describe('session road probes', () => {
  it('P101 cli: the allowed adapter binary on the core PATH is ok; a missing binary or an adapter outside the build fails with a fix; no registry or no allowed route is unknown', async () => {
    const base = { allowed: [CLAUDE], env: pathEnv() };
    const found = await run(cliProbe, { ...base, cliOf: () => FAKE });
    expect(found).toMatchObject({ status: 'ok', detail: expect.stringContaining(FAKE) });

    expect(await run(cliProbe, { ...base, cliOf: () => 'agentdeck-no-such-cli' })).toEqual({
      status: 'fail',
      detail: 'claude: «agentdeck-no-such-cli» not found (searched 1 dirs)',
      fix: 'install the CLI or put it on the PATH the core was started with',
    });
    expect(await run(cliProbe, { ...base, cliOf: () => undefined })).toMatchObject({
      status: 'fail',
      detail: 'claude: adapter not in this core build',
    });
    // Одна годная тройка из двух — задача идёт ею, негодная названа.
    const mixed = await run(cliProbe, {
      ...base,
      allowed: [CLAUDE, { ...CLAUDE, adapter: 'qwen' }],
      cliOf: (id) => (id === 'claude' ? FAKE : 'agentdeck-no-such-cli'),
    });
    expect(mixed).toMatchObject({ status: 'ok', detail: expect.stringMatching(/unusable qwen/) });

    expect(await run(cliProbe, { ...base })).toEqual({
      status: 'unknown',
      detail: 'not wired: the conductor has no adapter registry',
    });
    expect(await run(cliProbe, { allowed: [], cliOf: () => FAKE, env: pathEnv() })).toMatchObject({
      status: 'unknown',
      detail: 'task allows no route: no CLI and no route to check',
    });
  });

  it('P101 route: an allowed route in the registry is ok; an unknown id or a kind mismatch fails; no registry is unknown', async () => {
    const routes = createRouteRegistry([createCliLoginRoute({ id: 'claude' })]);
    expect(await run(routeProbe, { allowed: [CLAUDE], routes })).toEqual({
      status: 'ok',
      detail: 'cli-login:claude (cli-login)',
    });
    expect(
      await run(routeProbe, {
        allowed: [{ ...CLAUDE, route: { kind: 'local', id: 'own-model' } }],
        routes,
      }),
    ).toEqual({
      status: 'fail',
      detail: 'own-model: not in the route registry',
      fix: 'add the route to the core route config or allow an existing one',
    });
    expect(
      await run(routeProbe, {
        allowed: [{ ...CLAUDE, route: { kind: 'stub', id: 'cli-login:claude' } }],
        routes,
      }),
    ).toMatchObject({
      status: 'fail',
      detail: 'cli-login:claude: registry kind cli-login, task names stub',
    });
    expect(await run(routeProbe, { allowed: [CLAUDE] })).toEqual({
      status: 'unknown',
      detail: 'not wired: the conductor has no route registry',
    });
  });

  it('P101 core-mcp and capture: the session road bridge entry and the preload on disk are ok; a missing script, node or preload fails; endpoints not registered fail', async () => {
    const entry = coreMcpServers(DEFAULT_NODE_ARGV)[CORE_MCP_SERVER];
    if (!entry) throw new Error('no core MCP entry');
    const ok = await run(coreMcpProbe, { allowed: [], coreMcp: entry });
    expect(ok).toMatchObject({ status: 'ok', detail: expect.stringMatching(/run\.ts agentdeck$/) });
    const gone = join(root, 'gone', 'run.ts');
    expect(
      await run(coreMcpProbe, { allowed: [], coreMcp: { ...entry, args: ['--x', gone] } }),
    ).toEqual({
      status: 'fail',
      detail: `core MCP entry ${gone} is missing`,
      fix: 'reinstall the core (its mcp/run.ts is gone)',
    });
    expect(
      await run(coreMcpProbe, {
        allowed: [],
        coreMcp: { command: 'agentdeck-no-such-node', args: [] },
        env: pathEnv(),
      }),
    ).toMatchObject({
      status: 'fail',
      detail: 'core MCP command «agentdeck-no-such-node» not found',
    });
    expect(await run(coreMcpProbe, { allowed: [] })).toMatchObject({ status: 'unknown' });

    const capture = { preload: CAPTURE_SHIM, endpointRegistered: true };
    expect(await run(captureProbe, { allowed: [], capture })).toMatchObject({ status: 'ok' });
    const noShim = join(root, 'capture-preload.cjs');
    expect(
      await run(captureProbe, { allowed: [], capture: { ...capture, preload: noShim } }),
    ).toMatchObject({ status: 'fail', detail: `capture preload ${noShim} is missing` });
    expect(
      await run(captureProbe, { allowed: [], capture: { ...capture, endpointRegistered: false } }),
    ).toMatchObject({
      status: 'fail',
      detail: 'capture endpoints are not registered on the core API',
    });
    expect(await run(captureProbe, { allowed: [] })).toMatchObject({ status: 'unknown' });
  });

  it('P101 wiring: splitEnvFor runs the session road probes inside the one preflight of zone E — with both registries every session road is ok, without the route registry the start is refused naming the road', async () => {
    const layout = layoutOf(join(root, 'home'));
    const registry = createTaskRegistry(layout.tasks, journalDeps());
    const verifier = buildVerifierWiring({ registry, layout });
    // Поиск CLI — по PATH, который дорога сессии даст запуску (здесь только каталоги исполнителя),
    // а не по PATH процесса ядра: на машине с настоящим claude проба иначе зеленела бы чужим CLI.
    const road = {
      searchPath: async (prefix: readonly string[] = []) =>
        prefix.join(process.platform === 'win32' ? ';' : ':'),
    };
    const base = { registry, layout, verifier, road, note: () => undefined };
    const repo = gitRepo(root, 'svc');
    const repos = [{ repoKey: 'svc', path: repo }];
    try {
      const registries = {
        adapters: createAdapterRegistry(),
        routes: createRouteRegistry([createCliLoginRoute({ id: 'claude' })]),
      };
      const wired = splitEnvFor({
        ...(base as unknown as ConductorWiringDeps),
        ...registries,
        loop: { pathPrefix: [bin] },
      });
      const full = await runTaskPreflight(repos, [CLAUDE], wired);
      const row = (rows: typeof full.rows, name: string) => rows.find((r) => r.road === name);
      for (const name of ['cli', 'route', 'core-mcp', 'capture'])
        expect(row(full.rows, name)?.status, name).toBe('ok');
      expect(row(full.rows, 'cli')?.detail).toContain(bin);

      // Без каталога исполнителя проба не находит CLI, даже если он есть на PATH процесса ядра.
      const bare = await runTaskPreflight(
        repos,
        [CLAUDE],
        splitEnvFor({ ...(base as unknown as ConductorWiringDeps), ...registries }),
      );
      expect(row(bare.rows, 'cli')?.status).toBe('failed');

      const unwired = await runTaskPreflight(
        repos,
        [CLAUDE],
        splitEnvFor(base as unknown as ConductorWiringDeps),
      );
      expect(unwired.start).toBe(false);
      expect(row(unwired.rows, 'route')).toEqual({
        road: 'route',
        status: 'failed',
        detail: 'not wired: the conductor has no route registry',
      });
    } finally {
      registry.closeAll();
    }
  });

  it('launch allowed set: splitEnvFor offers the cli-login route of each adapter configured in the route registry, any model, level 2 — a non-login route under a login id and a registry-less boot give nothing', () => {
    const layout = layoutOf(join(root, 'home-allowed'));
    const registry = createTaskRegistry(layout.tasks, journalDeps());
    const verifier = buildVerifierWiring({ registry, layout });
    const base = {
      registry,
      layout,
      verifier,
      note: () => undefined,
    } as unknown as ConductorWiringDeps;
    try {
      // Маршрут под id входа qwen, но не входа — подпиской не считается.
      const fake = { ...createCliLoginRoute({ id: 'qwen' }), kind: 'stub' as const };
      const wired = splitEnvFor({
        ...base,
        adapters: createAdapterRegistry(),
        routes: createRouteRegistry([createCliLoginRoute({ id: 'claude' }), fake]),
      });
      expect(wired.allowedRoutes()).toEqual({
        routes: [
          {
            adapter: 'claude',
            route: { kind: 'cli-login', id: 'cli-login:claude' },
            modelPattern: '*',
          },
        ],
        level: 2,
      });
      expect(splitEnvFor(base).allowedRoutes()).toEqual({ routes: [], level: 2 });
    } finally {
      registry.closeAll();
    }
  });
});
