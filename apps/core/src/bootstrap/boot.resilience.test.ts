import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../adapters/index.ts';
import { reconcileTask } from '../conductor/reconcile.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, fakeClock, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { readProcs } from '../platform/procs-file.ts';
import type { RouteRegistry } from '../routes/registry.ts';
import { actionReaders } from './action-readers.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { buildCoreRoutes } from './core-routes.ts';

/**
 * Загрузка, которую не роняет одна задача, и остановка, которую не обрывает один сбой (ревью
 * F-49, F-26, F-50, F-107) — на настоящем доме, настоящем журнале и настоящих часах.
 */

let core: BootedCore | undefined;
let holder: ChildProcess | undefined;
afterEach(async () => {
  holder?.kill();
  holder = undefined;
  await core?.stop().catch(() => undefined);
  core = undefined;
});

/** Реестр маршрутов дома, у которого `list()` ведёт себя, как скажет тест. */
function routesWith(home: string, list: (real: RouteRegistry) => RouteRegistry['list']) {
  const layout = ensureCoreHome(home);
  const real = buildCoreRoutes(
    createAdapterRegistry(),
    layout,
    {},
    {
      bootId: newId(),
      journal: { decision: () => {}, created: () => {}, verified: () => {}, leak: () => {} },
    },
  );
  const patched = list(real);
  return new Proxy(real, {
    get: (target, key) => {
      if (key === 'list') return patched;
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

describe('core boot resilience', () => {
  it.runIf(process.platform === 'win32')(
    'F-49 one task journal locked by another process (FileShare.Read) does not abort the boot; that task is flagged, the other is live',
    async () => {
      const home = join(tempDir('boot-lock-'), 'core');
      const layout = ensureCoreHome(home);
      const seed = createTaskRegistry(layout.tasks, deps());
      const healthy = await seed.create(CREATED);
      const bad = await seed.create(CREATED);
      seed.closeAll();
      const file = join(bad.dir, 'journal.jsonl').replace(/'/g, "''");
      holder = spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$f=[IO.File]::Open('${file}','Open','Read','Read'); Write-Output LOCKED; Start-Sleep 60; $f.Close()`,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      await new Promise<void>((resolve) =>
        holder?.stdout?.on('data', (d: Buffer) => String(d).includes('LOCKED') && resolve()),
      );
      core = await bootCore({ home, build: 'lock-test' });
      expect(core.registry.live(healthy.taskId)).toBeDefined();
      expect(core.registry.live(bad.taskId)).toBeUndefined();
      const summary = core.registry.list().find((t) => t.taskId === bad.taskId);
      expect(summary?.attention).toMatch(/EBUSY|EPERM|EACCES/);
    },
    60_000,
  );

  it('F-26 boot reconcile counts the deadline from the journaled first try: an action unknown for 2 h asks the human at boot', async () => {
    const home = join(tempDir('boot-p86-'), 'core');
    const layout = ensureCoreHome(home);
    const clock = fakeClock(Date.now() - 2 * 60 * 60_000);
    const seed = createTaskRegistry(layout.tasks, deps({ clock }));
    const task = await seed.create(CREATED);
    const actionId = newId();
    task.append({
      kind: 'action.started',
      actor: 'core',
      data: { actionId, kind: 'push', target: 'origin/feature', idempotencyHint: '' },
    });
    const first = await reconcileTask(
      task,
      actionReaders(),
      { now: () => clock.stamp().at },
      new Map(),
    );
    expect(first.map((d) => d.verdict)).toEqual(['retry']);
    seed.closeAll();

    core = await bootCore({ home, build: 'p86-test' });
    const live = core.registry.live(task.taskId);
    expect(live?.state.actions[actionId]?.status).toBe('awaiting-human');
    expect(Object.values(live?.state.asks ?? {}).map((a) => a.point)).toEqual([4]);
  }, 60_000);

  it('F-50 the clock baseline is taken when ticking starts: a slow boot is not a clock jump', async () => {
    const home = join(tempDir('boot-clock-'), 'core');
    let calls = 0;
    const routes = routesWith(home, (real) => () => {
      calls += 1;
      if (calls === 1) {
        // Долгая загрузка без сна машины: 6,5 с работы между созданием часов и тиками.
        const until = performance.now() + 6_500;
        while (performance.now() < until);
      }
      return real.list();
    });
    core = await bootCore({ home, build: 'clock-test', routes });
    expect(core.clock.tick()).toBeUndefined();
  }, 60_000);

  it('F-107 a throwing step in stop() still unregisters the core from procs.json and rejects with the cause', async () => {
    const home = join(tempDir('boot-stop-'), 'core');
    let calls = 0;
    const routes = routesWith(home, (real) => () => {
      calls += 1;
      if (calls > 1) throw new Error('route registry broken at shutdown');
      return real.list();
    });
    const booted = await bootCore({ home, build: 'stop-test', routes });
    core = booted;
    const procsPath = booted.layout.procs;
    await expect(booted.stop()).rejects.toThrow(/route registry broken/);
    const after = readProcs(procsPath);
    expect('value' in after && after.value.cores).toEqual([]);
  }, 60_000);
});
