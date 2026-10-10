import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../../context.ts';
import {
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
} from '../../../domains/project-tests/project-tests.ts';
import { registerProjectTestsRoutes } from '../../project-tests-routes/project-tests-routes.ts';

/**
 * F-327. PDF прогона без id отвечал «прогона «» нет», хотя соседние маршруты
 * (прогон, сравнение, выгрузка) называют это ошибкой вызова — 400 кодом.
 */
describe('GET /api/project-tests/run/pdf без id', () => {
  let app: FastifyInstance;
  let project = '';

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-pdf-'));
    app = Fastify();
    registerProjectTestsRoutes(
      app,
      {
        backupDir: project,
        store: {
          getProjectByPath: () => undefined,
          isTestsAutoAccept: () => false,
          getSettings: () => ({
            language: 'ru',
            integrations: { jira: { enabled: false }, confluence: { enabled: false } },
          }),
        },
        location: { paths: { appData: project } },
      } as unknown as ServerContext,
      new ProjectTestRunRegistry(),
      new ProjectTestManualRegistry(),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const id of [undefined, '', '  ']) {
    it(`id=${JSON.stringify(id)} — 400 run-unspecified`, async () => {
      const query = new URLSearchParams({ path: project, ...(id === undefined ? {} : { id }) });
      const response = await app.inject({
        method: 'GET',
        url: `/api/project-tests/run/pdf?${query}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ messageCode: 'run-unspecified' });
    });
  }
});
