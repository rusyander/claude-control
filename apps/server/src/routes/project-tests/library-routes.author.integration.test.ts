import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestsView } from '@agentdeck/contracts';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import type { ServerContext } from '../../context.ts';
import { ProjectTestManualRegistry, ProjectTestRunRegistry } from '../../domains/project-tests.ts';
import { registerProjectTestsRoutes } from '../project-tests-routes.ts';

/**
 * F-297. Автор кейса брался из тела запроса: любой клиент мог пометить кейс
 * написанным агентом. Агента панели отличает пометка исполнителя действий
 * (`PANEL_AGENT_HEADER`), которую ставит `app.inject` агента, а не поле тела.
 */
describe('POST /api/project-tests/case: автор кейса', () => {
  let app: FastifyInstance;
  let project = '';
  let backupDir = '';

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-author-'));
    backupDir = mkdtempSync(join(tmpdir(), 'cc-tests-author-data-'));
    app = Fastify();
    registerProjectTestsRoutes(
      app,
      {
        backupDir,
        store: {
          getProjectByPath: () => undefined,
          isTestsAutoAccept: () => false,
          getSettings: () => ({ integrations: { atlassian: { enabled: false } } }),
        },
        location: { paths: { appData: backupDir } },
      } as unknown as ServerContext,
      new ProjectTestRunRegistry(),
      new ProjectTestManualRegistry(),
    );
    await app.ready();
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/group',
      payload: { path: project, id: 'gui', title: 'GUI' },
    });
  });

  afterEach(async () => {
    await app.close();
    for (const dir of [project, backupDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const save = async (title: string, headers: Record<string, string>, author?: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/case',
      headers,
      payload: {
        path: project,
        groupId: 'gui',
        testCase: { title, steps: ['шаг'] },
        ...(author ? { author } : {}),
      },
    });
    expect(response.statusCode).toBe(200);
    const cases = (response.json() as ProjectTestsView).groups[0]?.cases ?? [];
    return cases.find((item) => item.title === title)?.source;
  };

  it('поле author в теле без пометки агента — правка человека', async () => {
    expect(await save('Из тела', {}, 'agent')).toBe('human');
  });

  it('пометка исполнителя агента — кейс агента', async () => {
    expect(await save('От агента', { [PANEL_AGENT_HEADER]: '1' })).toBe('agent');
  });
});
