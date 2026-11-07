import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LearnedKey } from '@agentdeck/contracts/core/economy';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { presetStep } from '../../conductor/scenario/presets.ts';
import {
  keyOf,
  learnedCachePath,
  type JournalSamples,
  type LearnedCache,
} from '../../economy/learned/index.ts';
import { WindowBook } from '../../economy/window/index.ts';
import {
  CREATED,
  deps as journalDeps,
  tempDir,
} from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { createSessionTokens } from '../../policy/session-tokens/session-tokens.ts';
import { bootEconomy } from './boot-economy.ts';
import { createContextWiring } from './context.ts';

/**
 * Подъём по обучению в сборке ядра (этап 11, F1): `bootEconomy` отдаёт суду `tier` подъём над
 * своим прочитанным выученным с порогом из настроек ведущего, а выученное старше минуты
 * перечитывает в фоне — задача, законченная после запуска ядра, учит следующую без перезапуска.
 * Вклады журналов лежат в кэше выученного рядом с каталогом задач — так их читает `readLearned`.
 */

const KEY: LearnedKey = {
  project: 'r1',
  stepKind: 'work',
  adapter: 'claude',
  route: 'claude-login',
  model: 'sonnet',
  role: 'mechanical',
};

/** Законченная задача с одной красной первой попыткой ключа. */
function failedRun(taskId: string, at: number): JournalSamples {
  return {
    steps: [
      {
        key: KEY,
        tokens: 0,
        activeMs: 0,
        turns: 0,
        outcome: 'failed',
        lowered: true,
        firstPass: { sampleId: `s-${taskId}`, at, passed: false, rung: 'sonnet·high', class: null },
      },
    ],
    task: { taskId, projects: ['r1'], scenarioId: null, tokens: 0, activeMs: 0, outcome: 'done' },
    toolMs: {},
  };
}

function plant(tasksDir: string, count: number, journals: LearnedCache['journals']): void {
  for (let i = 0; i < count; i += 1) {
    const id = newId();
    mkdirSync(join(tasksDir, id), { recursive: true });
    journals[id] = failedRun(id, Object.keys(journals).length);
  }
  const cache: LearnedCache = { version: 3, journals, resets: {} };
  writeFileSync(learnedCachePath(dirname(tasksDir)), JSON.stringify(cache));
}

describe('stage 11 boot economy wires the learned raise (F1)', () => {
  it('stage 11 bootEconomy: the tier step facts carry learnedRaise over the read table; older than a minute it is re-read in the background', async () => {
    const layout = layoutOf(join(tempDir('boot-learned-'), 'home'));
    mkdirSync(join(layout.root, 'cache'), { recursive: true });
    const registry = createTaskRegistry(layout.tasks, journalDeps());
    const journals: LearnedCache['journals'] = {};
    plant(layout.tasks, 8, journals);
    let clock = 1_000_000;
    const economy = bootEconomy({
      tasksDir: layout.tasks,
      windows: new WindowBook(),
      context: createContextWiring({ homeRoot: layout.root }),
      adapters: createAdapterRegistry(),
      sessionTokens: createSessionTokens('k'.repeat(64)),
      pin: () => ({}),
      now: () => clock,
    });
    await economy.history();
    const task = await registry.create(CREATED);
    try {
      const facts = economy.run.routingEnv!(task).step!(task.state, {
        stepId: null,
        unitId: null,
        def: presetStep('work', 'work', 'Работа', []),
      });
      const raise = () => facts.learnedRaise!({ key: KEY, class: null });
      // Восемь красных первых попыток из восьми: порог умолчаний (85 %, ≥ 8) — одна ступень.
      expect(raise()).toMatchObject({ rungs: 1, basis: 'key', samples: 0 });
      expect(raise()?.evidence).toHaveLength(8);
      expect(keyOf(KEY)).toBe('r1|work|claude|claude-login|sonnet|mechanical');

      // Ещё восемь задач закончились после чтения: до минуты суд идёт по прочитанному.
      plant(layout.tasks, 8, journals);
      clock += 30_000;
      expect(raise()?.rungs).toBe(1);
      // Суд за судом в ту же минуту: ни один не перечитал — вклады новых задач ещё не видны.
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        expect(raise()?.rungs).toBe(1);
      }
      // Старше минуты — перечитывается в фоне; следующий суд видит новое окно.
      clock += 31_000;
      expect(raise()?.rungs).toBe(1);
      for (let i = 0; i < 100 && economy.learned()?.firstPass?.[keyOf(KEY)]?.length !== 16; i += 1)
        await new Promise((r) => setTimeout(r, 10));
      expect(raise()?.rungs).toBe(2);
    } finally {
      task.close();
    }
  });

  it('stage 11 bootEconomy: a failed background re-read keeps the last read table — an earned raise is never dropped by a read fault (P140 no auto demotion)', async () => {
    const root = tempDir('boot-learned-fault-');
    const layout = layoutOf(join(root, 'home'));
    mkdirSync(join(layout.root, 'cache'), { recursive: true });
    // Задача суда живёт в своём каталоге: каталог выученного ломается, её журнал — нет.
    const registry = createTaskRegistry(join(root, 'live-tasks'), journalDeps());
    plant(layout.tasks, 8, {});
    let clock = 1_000_000;
    const economy = bootEconomy({
      tasksDir: layout.tasks,
      windows: new WindowBook(),
      context: createContextWiring({ homeRoot: layout.root }),
      adapters: createAdapterRegistry(),
      sessionTokens: createSessionTokens('k'.repeat(64)),
      pin: () => ({}),
      now: () => clock,
    });
    await economy.history();
    const task = await registry.create(CREATED);
    try {
      const facts = economy.run.routingEnv!(task).step!(task.state, {
        stepId: null,
        unitId: null,
        def: presetStep('work', 'work', 'Работа', []),
      });
      const raise = () => facts.learnedRaise!({ key: KEY, class: null });
      expect(raise()?.rungs).toBe(1);
      // Каталог задач не читается (на его месте файл): перечитывание в фоне падает.
      renameSync(layout.tasks, `${layout.tasks}.gone`);
      writeFileSync(layout.tasks, 'not a dir');
      clock += 61_000;
      raise();
      for (let i = 0; i < 50; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(economy.learned()).toBeNull();
      expect(raise()?.rungs).toBe(1);
    } finally {
      task.close();
    }
  });
});
