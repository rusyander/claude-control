import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import type { TaskRegistry } from '../conductor/tasks.ts';
import { writeLibraryScenario } from '../conductor/scenario/index.ts';
import { forkOfFeature } from '../conductor/scenario/__fixtures__/scenario-harness.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { commandEnv } from '../conductor/commands/__fixtures__/command-env.ts';
import { layoutOf } from '../platform/core-home.ts';
import type { RouteContext } from './route-context.types.ts';
import { registerScenarios } from './scenarios.ts';

/**
 * Заголовки пресетов на языке панели (этап 10, F4): `?lang=en` — английские заголовки пресета и его
 * шагов, без языка и с чужим — русские данные пресета, как были. Сценарий библиотеки — текст
 * человека, он не переводится.
 */

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

function api(home: string) {
  const app = Fastify();
  apps.push(app);
  const ctx = {
    registry: { tasksDir: layoutOf(tempDir('api-scn-lang-tasks-')).tasks } as TaskRegistry,
    env: commandEnv({ home }),
    requireRead: () => 'core',
  } as Pick<RouteContext, 'registry' | 'env' | 'requireRead'> as RouteContext;
  registerScenarios(app, ctx);
  return async (url: string) => (await app.inject({ method: 'GET', url })).json();
}

const titles = (s: Scenario): string[] => [s.title, ...s.steps.map((st) => st.title)];

describe('preset titles follow the panel language', () => {
  it('GET /v1/scenarios?lang=en names every preset and step in English; no lang and an unknown lang keep the Russian data', async () => {
    const home = tempDir('api-scn-lang-');
    await writeLibraryScenario(layoutOf(home).scenarios, forkOfFeature('team-flow', 1));
    const get = api(home);
    const en = (await get('/v1/scenarios?lang=en')) as { presets: Scenario[]; library: Scenario[] };
    const bugFix = en.presets.find((p) => p.id === 'bug-fix') as Scenario;
    expect(titles(bugFix)).toEqual([
      'Bug fix',
      'Intake',
      'Plan',
      'Work',
      'Review',
      'Review fixes',
      'Final check',
      'Publish',
      'Reviewer replies',
    ]);
    // Ни одной кириллицы в английском списке пресетов.
    expect(en.presets.flatMap(titles).filter((t) => /\p{Script=Cyrillic}/u.test(t))).toEqual([]);
    // Сценарий библиотеки — как записал человек.
    const lib = en.library.find((s) => s.id === 'team-flow') as Scenario;
    expect(titles(lib)).toEqual(titles(forkOfFeature('team-flow', 1)));

    for (const url of ['/v1/scenarios', '/v1/scenarios?lang=de']) {
      const ru = (await get(url)) as { presets: Scenario[] };
      const p = ru.presets.find((x) => x.id === 'bug-fix') as Scenario;
      expect(titles(p).slice(0, 4)).toEqual([
        'Исправление ошибки',
        'Разбор запроса',
        'План',
        'Работа',
      ]);
    }
  });

  it('GET /v1/scenarios/:ref?lang=en reads the preset in English, without lang in Russian', async () => {
    const get = api(tempDir('api-scn-lang-'));
    const en = (await get('/v1/scenarios/review-only@1?lang=en')) as { scenario: Scenario };
    expect(titles(en.scenario)).toEqual(['Review only', 'Intake', 'Review', 'Report']);
    const ru = (await get('/v1/scenarios/review-only@1')) as { scenario: Scenario };
    expect(titles(ru.scenario)).toEqual(['Только ревью', 'Разбор запроса', 'Ревью', 'Отчёт']);
  });
});
