import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RecordedRecordReply, RecordedView } from '@agentdeck/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerContext } from '../../../context.ts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import {
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
} from '../../../domains/project-tests/project-tests.ts';
import type { RecordedWalkRequest } from '../../../domains/project-tests/recorded/recorded.ts';
import { walkRows } from '../../../domains/project-tests/recorded/__fixtures__/walk-rows.ts';
import { registerProjectTestsRoutes } from '../../project-tests-routes/project-tests-routes.ts';
import { registerRecordedRoutes } from './recorded-routes.ts';

/**
 * Ручки записанных проходов через HTTP: список, запись прохода в кейс и спек (через настоящую
 * таблицу маршрутов раздела), отказ чужому каталогу и решение без расхождения; задача прохода —
 * через подставной порт ядра (настоящее ядро тест не трогает).
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Остаётся в temp — на результат не влияет.
  }
}

describe('project-tests recorded routes', () => {
  let app: FastifyInstance;
  let direct: FastifyInstance;
  let project = '';
  let stranger = '';
  let appData = '';
  const opened: RecordedWalkRequest[] = [];

  beforeEach(async () => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-recorded-routes-')));
    stranger = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-recorded-stranger-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-recorded-routes-data-')));
    const store = new AppStore(appData);
    store.addProject({ id: 'p-stand', name: 'stand', path: project });
    const ctx = {
      store,
      backupDir: join(appData, 'backups'),
      location: { paths: { root: appData, appData, settings: join(appData, 'settings.json') } },
    } as unknown as ServerContext;
    const runs = new ProjectTestRunRegistry();
    const manual = new ProjectTestManualRegistry();
    app = Fastify();
    registerProjectTestsRoutes(app, ctx, runs, manual);
    await app.ready();
    opened.length = 0;
    direct = Fastify();
    registerRecordedRoutes(
      direct,
      { ctx, runs, manual },
      {
        walk: {
          open: async (request) => {
            opened.push(request);
            return { taskId: 'walk-1' };
          },
        },
      },
    );
    await direct.ready();
  });

  afterEach(async () => {
    await app.close();
    await direct.close();
    for (const dir of [project, stranger, appData]) dropTemp(dir);
  });

  const list = async (): Promise<RecordedView> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/project-tests/recorded?path=${encodeURIComponent(project)}`,
      })
    ).json<RecordedView>();

  it('records a walk into a case and a spec, then lists it', async () => {
    expect(await list()).toEqual({ cases: [] });
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/recorded',
      payload: {
        path: project,
        groupId: 'scenarios',
        title: 'Вход на стенд',
        taskId: '0190a000-0000-7000-8000-00000000abcd',
        ...walkRows('http://127.0.0.1:4173'),
      },
    });
    expect(response.statusCode).toBe(200);
    const reply = response.json<RecordedRecordReply>();
    expect(reply.testName).toBe('recorded > Вход на стенд');
    expect(readFileSync(join(project, reply.file), 'utf8')).toContain(
      '// recorded-test: recorded > Вход на стенд',
    );
    const view = await list();
    expect(view.cases).toEqual([
      expect.objectContaining({
        caseId: reply.caseId,
        file: reply.file,
        unchecked: 2,
        history: [],
      }),
    ]);
  });

  it('refuses a folder outside the registry and a verdict without a mismatch', async () => {
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/project-tests/recorded',
      payload: {
        path: stranger,
        groupId: 'g',
        title: 't',
        taskId: 'x',
        ...walkRows('http://127.0.0.1:1'),
      },
    });
    expect(foreign.statusCode).toBe(403);
    const verdict = await app.inject({
      method: 'POST',
      url: '/api/project-tests/recorded/verdict',
      payload: { path: project, verdict: 'defect' },
    });
    expect(verdict.statusCode).toBe(400);
    const replay = await app.inject({
      method: 'POST',
      url: '/api/project-tests/recorded/replay',
      payload: { path: project },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json<{ message: string }>().message).toContain('Записанных сценариев нет');
  });

  it('starts a stand walk through the core port with the goal and the environment secrets by name', async () => {
    const response = await direct.inject({
      method: 'POST',
      url: '/api/project-tests/recorded/walk',
      payload: { path: project, goal: 'войти и увидеть приветствие' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ taskId: 'walk-1' });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.text).toContain('войти и увидеть приветствие');
    expect(opened[0]!.title).toBe('Проход по стенду: войти и увидеть приветствие');
    const empty = await direct.inject({
      method: 'POST',
      url: '/api/project-tests/recorded/walk',
      payload: { path: project, goal: '  ' },
    });
    expect(empty.statusCode).toBe(400);
    expect(opened).toHaveLength(1);
  });
});
