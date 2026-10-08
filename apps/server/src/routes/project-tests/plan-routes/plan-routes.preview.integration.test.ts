import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestPlanPreview } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import type { TestsDeps } from '../shared/shared.ts';
import { registerTestPlanRoutes } from './plan-routes.ts';

/**
 * Предпросмотр сборки плана правилом — GET без записи. Его читает карточка
 * агента: сборка карточки не смеет писать, поэтому у предпросмотра нет ни
 * параметра сохранения, ни пути к нему. Доказательство — снимок каждого байта
 * проекта и каталога данных панели до и после запросов всеми четырьмя правилами.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

/** Путь → sha256 содержимого, для каждого файла и каталога под `root`. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const key = relative(root, path).replace(/\\/g, '/');
      if (statSync(path).isDirectory()) {
        out[`${key}/`] = 'dir';
        walk(path);
      } else {
        out[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

const testCase = (id: string, title: string, priority: string, duration: number) => ({
  id,
  type: 'case',
  title,
  steps: [{ action: 'Открыть', expected: 'Открыто' }],
  status: 'unknown',
  source: 'human',
  priority,
  duration,
  requirements: ['REL-1'],
});

describe('project-tests plan preview route (read-only)', () => {
  let app: FastifyInstance;
  let project = '';
  let appData = '';

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-plan-preview-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-tests-plan-preview-data-'));
    mkdirSync(join(project, '.agent', 'tests', 'plans'), { recursive: true });
    writeFileSync(
      join(project, '.agent', 'tests', 'gui.tests.json'),
      JSON.stringify({
        version: 1,
        title: 'GUI',
        cases: [
          testCase('gui-001', 'Вход в панель', 'blocker', 2),
          testCase('gui-002', 'Выход из панели', 'high', 3),
          testCase('gui-003', 'Смена темы', 'low', 5),
        ],
      }),
    );
    const store = new AppStore(appData);
    const ctx = {
      store,
      location: { paths: { root: appData, appData, settings: join(appData, 'settings.json') } },
    } as unknown as ServerContext;
    app = Fastify();
    registerTestPlanRoutes(app, { ctx } as unknown as TestsDeps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(project);
    dropTemp(appData);
  });

  const preview = (query: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/api/project-tests/plan/preview',
      query: { path: project, ...query },
    });

  it('smoke within a budget — the same pick as the build button, nothing saved', async () => {
    const answer = await preview({ recipe: 'smoke', budget: '5', title: 'Дым 5' });
    expect(answer.statusCode).toBe(200);
    const body = answer.json<{ preview: ProjectTestPlanPreview }>();
    expect(body.preview.title).toBe('Дым 5');
    expect(body.preview.budget).toBe(5);
    expect(body.preview.picked.map((pick) => pick.caseId)).toEqual(['gui-001', 'gui-002']);
    expect(body.preview.left.map((pick) => pick.caseId)).toContain('gui-003');
    expect(Object.keys(body)).toEqual(['preview']);

    // Тот же отбор, что у кнопки «Показать» (POST без сохранения).
    const button = await app.inject({
      method: 'POST',
      url: '/api/project-tests/plan/build',
      payload: { path: project, recipe: 'smoke', budget: 5, title: 'Дым 5' },
    });
    expect(button.json()).toEqual(body);
  });

  it('every recipe, even with save=1 in the query, leaves every byte of the project and panel data as it was', async () => {
    const projectBefore = snapshot(project);
    const dataBefore = snapshot(appData);
    const queries: Array<Record<string, string>> = [
      { recipe: 'smoke', budget: '30', save: '1' },
      { recipe: 'diff', save: 'true' },
      { recipe: 'release', release: 'REL-1', save: 'true' },
      { recipe: 'flaky', threshold: '0.5', save: 'true' },
    ];
    for (const query of queries) {
      const answer = await preview(query);
      expect({ recipe: query.recipe, status: answer.statusCode }).toEqual({
        recipe: query.recipe,
        status: 200,
      });
      expect(answer.json()).not.toHaveProperty('plan');
    }
    expect(snapshot(project)).toEqual(projectBefore);
    expect(snapshot(appData)).toEqual(dataBefore);
    expect(readdirSync(join(project, '.agent', 'tests', 'plans'))).toEqual([]);
  });

  it('unknown recipe and missing path — refused with the domain code, nothing written', async () => {
    const before = snapshot(project);
    const unknown = await preview({ recipe: 'everything' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ messageCode: 'plan-recipe-unknown' });
    const noPath = await app.inject({
      method: 'GET',
      url: '/api/project-tests/plan/preview',
      query: { recipe: 'smoke' },
    });
    expect(noPath.statusCode).toBe(400);
    expect(snapshot(project)).toEqual(before);
  });

  // Ревью 28.09, R2: «abc» становилось NaN и молча превращалось в бюджет по умолчанию.
  it('a budget or threshold that is not a number — refused with the field named, not replaced by the default', async () => {
    const budget = await preview({ recipe: 'smoke', budget: 'abc' });
    expect(budget.statusCode).toBe(400);
    expect(budget.json()).toMatchObject({
      messageCode: 'tests-plan-number-invalid',
      params: { field: 'budget', value: 'abc' },
    });
    const threshold = await preview({ recipe: 'flaky', threshold: 'половина' });
    expect(threshold.statusCode).toBe(400);
    expect(threshold.json()).toMatchObject({
      messageCode: 'tests-plan-number-invalid',
      params: { field: 'threshold', value: 'половина' },
    });
    // Пустое значение — по-прежнему «не задано», а не ошибка.
    expect((await preview({ recipe: 'smoke', budget: '' })).statusCode).toBe(200);
  });
});
