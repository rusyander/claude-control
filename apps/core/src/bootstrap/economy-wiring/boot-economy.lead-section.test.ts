import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LearnedKey } from '@agentdeck/contracts/core/economy';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { presetStep } from '../../conductor/scenario/presets.ts';
import { learnedCachePath, type LearnedCache } from '../../economy/learned/index.ts';
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
 * Раздел ведущего настройки ядра (`config.json`, `lead.defaults.promotion`) доходит до подъёма по
 * обучению в сборке экономики (этап 11, F1) — на каждый суд шага, без перезапуска: порог из файла,
 * а не умолчание. Настоящие чтение настройки, кэш выученного и суд; файлы во временном доме.
 */

const KEY: LearnedKey = {
  project: 'r1',
  stepKind: 'work',
  adapter: 'claude',
  route: 'claude-login',
  model: 'sonnet',
  role: 'mechanical',
};

function plantFailures(tasksDir: string, count: number): void {
  const journals: LearnedCache['journals'] = {};
  for (let i = 0; i < count; i += 1) {
    const id = newId();
    mkdirSync(join(tasksDir, id), { recursive: true });
    journals[id] = {
      steps: [
        {
          key: KEY,
          tokens: 0,
          activeMs: 0,
          turns: 0,
          outcome: 'failed',
          lowered: true,
          firstPass: {
            sampleId: `s-${id}`,
            at: i,
            passed: false,
            rung: 'sonnet·high',
            class: null,
          },
        },
      ],
      task: {
        taskId: id,
        projects: ['r1'],
        scenarioId: null,
        tokens: 0,
        activeMs: 0,
        outcome: 'done',
      },
      toolMs: {},
    };
  }
  const cache: LearnedCache = { version: 3, journals, resets: {} };
  writeFileSync(learnedCachePath(dirname(tasksDir)), JSON.stringify(cache));
}

describe('stage 11 boot economy reads the lead section for the learned raise', () => {
  it('a promotion minSamples in config.json above the samples holds the raise; the file edited back — the default raises again', async () => {
    const layout = layoutOf(join(tempDir('boot-lead-section-'), 'home'));
    mkdirSync(join(layout.root, 'cache'), { recursive: true });
    plantFailures(layout.tasks, 8);
    const promotion = (minSamples: number) =>
      writeFileSync(
        layout.config,
        JSON.stringify({
          lead: { defaults: { promotion: { threshold: 0.85, window: 20, minSamples } } },
        }),
      );
    promotion(12);
    const economy = bootEconomy({
      tasksDir: layout.tasks,
      windows: new WindowBook(),
      context: createContextWiring({ homeRoot: layout.root }),
      adapters: createAdapterRegistry(),
      sessionTokens: createSessionTokens('k'.repeat(64)),
      pin: () => ({}),
      now: () => 1_000_000,
    });
    await economy.history();
    const task = await createTaskRegistry(layout.tasks, journalDeps()).create(CREATED);
    try {
      // Каждый проход суда читает раздел ведущего заново (внутри прохода — одно чтение).
      const raise = () =>
        economy.run.routingEnv!(task).step!(task.state, {
          stepId: null,
          unitId: null,
          def: presetStep('work', 'work', 'Работа', []),
        }).learnedRaise!({ key: KEY, class: null });
      // Восемь красных из восьми, но файл требует двенадцать проб: подъёма нет.
      expect(raise()).toMatchObject({ rungs: 0, samples: 8 });
      // Правка файла доходит до следующего прохода без перезапуска: восьми проб снова хватает.
      promotion(8);
      expect(raise()).toMatchObject({ rungs: 1 });
    } finally {
      task.close();
    }
  });
});
