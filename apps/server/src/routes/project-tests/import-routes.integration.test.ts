import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestImportResult } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import { registerProjectTestsImportRoutes } from './import-routes.ts';

/**
 * Ввод-вывод по HTTP. На этом уровне важно ровно то, чего нет в домене: чужой
 * каталог и неизвестный формат отбиваются 400 с человеческим текстом, а
 * выгрузка уходит файлом — с заголовком, по которому браузер её сохранит.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

const JUNIT =
  '<testsuites><testsuite name="s">' +
  '<testcase classname="c" name="[gui-001] открывает чат" time="0.5"/>' +
  '<testcase classname="c" name="чужой" time="0.1"><failure message="упало"/></testcase>' +
  '</testsuite></testsuites>';

describe('project-tests import routes', () => {
  let app: FastifyInstance;
  let project = '';

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-io-'));
    mkdirSync(join(project, '.agent', 'tests'), { recursive: true });
    writeFileSync(
      join(project, '.agent', 'tests', 'gui.tests.json'),
      JSON.stringify({
        version: 1,
        title: 'GUI',
        cases: [{ id: 'gui-001', title: 'Открытие чата', steps: [], status: 'unknown' }],
      }),
    );

    app = Fastify();
    registerProjectTestsImportRoutes(app, {} as unknown as ServerContext);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(project);
  });

  it('результаты из CI ложатся на кейсы и возвращают итог импорта', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/import/results',
      payload: { path: project, format: 'junit', content: JUNIT },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ProjectTestImportResult>();
    expect(body).toMatchObject({ format: 'junit', read: 2, matched: 1, unmatched: ['чужой'] });
    expect(body.runId).toBeTruthy();
  });

  it('кейсы из CSV приезжают в указанную группу', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/import/cases',
      payload: {
        path: project,
        groupId: 'gui',
        format: 'csv',
        content: 'Название;Ожидание\nНовый кейс;Что-то видно',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ read: 1, created: 1 });
  });

  it('выгрузка уходит файлом с именем и типом', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/project-tests/export?path=${encodeURIComponent(project)}&groupId=gui&format=csv`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="gui-tests.csv"');
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain('Открытие чата');
  });

  it('чужой каталог, неизвестный формат и отсутствие группы — 400 с причиной', async () => {
    const cases = [
      { url: '/api/project-tests/import/results', payload: { path: '', format: 'junit' } },
      {
        url: '/api/project-tests/import/results',
        payload: { path: project, format: 'выдумка', content: 'x' },
      },
      {
        url: '/api/project-tests/import/cases',
        payload: { path: project, format: 'csv', content: 'a' },
      },
      {
        url: '/api/project-tests/import/cases',
        payload: { path: project, groupId: 'gui', format: 'docx', content: 'a' },
      },
    ];

    for (const item of cases) {
      const response = await app.inject({ method: 'POST', url: item.url, payload: item.payload });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ message: string }>().message).toBeTruthy();
    }
  });

  it('выгрузка без группы и в неизвестном формате — 400, сломанная группа — 404', async () => {
    const path = encodeURIComponent(project);
    writeFileSync(join(project, '.agent', 'tests', 'broken.tests.json'), '{ сломано');

    expect((await app.inject({ url: `/api/project-tests/export?path=${path}` })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ url: `/api/project-tests/export?path=${path}&groupId=gui&format=pdf` }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: `/api/project-tests/export?path=${path}&groupId=broken` }))
        .statusCode,
    ).toBe(404);
  });
});
