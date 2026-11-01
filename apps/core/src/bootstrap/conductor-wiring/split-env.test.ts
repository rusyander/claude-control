import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deps as journalDeps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { createSessionTokens } from '../../policy/session-tokens/session-tokens.ts';
import { bootEconomy } from '../economy-wiring/boot-economy.ts';
import { createContextWiring } from '../economy-wiring/context.ts';
import type { SessionRoad } from '../session-road.ts';
import { buildVerifierWiring } from '../verifier-wiring/index.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';
import { startConductor } from './index.ts';
import { splitEnvFor } from './split.ts';

/**
 * Одна среда деления на одну сборку дирижёра: ручка `ConductorHandle.split`, которую загрузка
 * отдаёт API и командам, — тот же объект, что держат крючки зоны D (`splitHooks(deps)` →
 * `splitEnvFor(deps)`). Вторая среда разошлась бы с крючками по пробам и подъёму вопроса.
 */

describe('conductor split env', () => {
  it('startConductor hands out the split env the split hooks hold: one instance per deps, a new deps builds its own', async () => {
    const layout = layoutOf(join(tempDir('split-env-'), 'home'));
    const registry = createTaskRegistry(layout.tasks, journalDeps());
    try {
      const deps: ConductorWiringDeps = {
        registry,
        layout,
        verifier: buildVerifierWiring({ registry, layout }),
        road: {} as SessionRoad,
        note: () => undefined,
        loop: false,
      };
      const conductor = startConductor(deps);
      expect(conductor.split).toBe(splitEnvFor(deps));
      expect(splitEnvFor(deps)).toBe(splitEnvFor(deps));
      expect(conductor.split.libraryDir).toBe(layout.scenarios);
      expect(splitEnvFor({ ...deps })).not.toBe(conductor.split);
      await conductor.stop();
    } finally {
      registry.closeAll();
    }
  });

  it('the split estimate reads history through the same learned reader the run economy budgets by', async () => {
    const layout = layoutOf(join(tempDir('split-env-'), 'home'));
    const registry = createTaskRegistry(layout.tasks, journalDeps());
    try {
      const economy = bootEconomy({
        tasksDir: layout.tasks,
        windows: new WindowBook(),
        context: createContextWiring({ homeRoot: layout.root }),
        adapters: createAdapterRegistry(),
        sessionTokens: createSessionTokens('k'.repeat(64)),
        pin: () => ({}),
      });
      const deps: ConductorWiringDeps = {
        registry,
        layout,
        verifier: buildVerifierWiring({ registry, layout }),
        road: {} as SessionRoad,
        note: () => undefined,
        loop: false,
        economy: economy.run,
        history: economy.history,
      };
      const env = splitEnvFor(deps);
      expect(env.history).toBe(economy.history);
      // Пустой дом: история читается (таблица без прогонов), а не «не подключено».
      expect(await env.history?.()).toMatchObject({ byKind: {} });
    } finally {
      registry.closeAll();
    }
  });
});
