import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestDraft } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
} from '../../../domains/project-tests/project-tests.ts';
import { registerProjectTestsRoutes } from '../../project-tests-routes/project-tests-routes.ts';

/**
 * Ответы приёмки, отказа и отката окно кладёт прямо в кэш черновика — значит,
 * они обязаны нести тот же вид, что `GET /drafts`: похожие, посчитанные
 * ПАНЕЛЬЮ (а не выдумка агента из файла), и коды предупреждений.
 */
const RUN = 'a1b2c3d4-0000-4000-8000-0000000000d1';
const NOW = '2026-09-28T10:00:00.000Z';
/** То, что агент написал в файл: обещание, а не факт. */
const AGENT_SIMILAR = [{ groupId: 'gui', caseId: 'gui-777', title: 'Выдумка', score: 0.99 }];

const proposed = (id: string, title: string) => ({
  op: 'add',
  groupId: 'gui',
  caseId: id,
  similarTo: AGENT_SIMILAR,
  case: {
    id,
    type: 'case',
    title,
    steps: [{ action: 'Открыть форму входа', expected: 'Форма видна' }],
    priority: 'high',
    status: 'unknown',
  },
});

describe('project-tests draft routes: ответ правки — тот же вид, что GET', () => {
  let project = '';
  let appData = '';
  let app: FastifyInstance;

  beforeEach(async () => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-draft-routes-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-draft-routes-data-')));
    const tests = join(project, '.agent', 'tests');
    mkdirSync(join(tests, 'drafts'), { recursive: true });
    writeFileSync(
      join(tests, 'gui.tests.json'),
      JSON.stringify({
        version: 1,
        title: 'GUI',
        cases: [
          {
            id: 'gui-001',
            title: 'Вход по паролю',
            steps: [{ action: 'Открыть форму входа', expected: 'Форма видна' }],
            status: 'unknown',
          },
        ],
      }),
    );
    writeFileSync(
      join(tests, 'drafts', `${RUN}.draft.json`),
      JSON.stringify({
        version: 1,
        runId: RUN,
        createdAt: NOW,
        items: [
          proposed('gui-002', 'Вход по паролю с запоминанием'),
          proposed('gui-003', 'Выход из системы'),
          // Удаление черновиком не делается — отброшено с предупреждением.
          { ...proposed('gui-001', 'Вход по паролю'), op: 'delete' },
        ],
      }),
    );
    const ctx = {
      store: new AppStore(appData),
      backupDir: join(appData, 'backups'),
      location: {
        paths: { root: appData, appData, settings: join(appData, 'settings.json') },
      },
    } as unknown as ServerContext;
    app = Fastify();
    registerProjectTestsRoutes(
      app,
      ctx,
      new ProjectTestRunRegistry(),
      new ProjectTestManualRegistry(),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    for (const dir of [project, appData]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const getDraft = async (): Promise<ProjectTestDraft> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/project-tests/drafts?path=${encodeURIComponent(project)}&runId=${RUN}`,
      })
    ).json<{ drafts: ProjectTestDraft[] }>().drafts[0] as ProjectTestDraft;

  const post = async (what: string, extra: Record<string, unknown> = {}) =>
    (
      await app.inject({
        method: 'POST',
        url: `/api/project-tests/draft/${what}`,
        payload: { path: project, runId: RUN, ...extra },
      })
    ).json<{ draft: ProjectTestDraft }>().draft;

  const similarOf = (draft: ProjectTestDraft, caseId: string) =>
    draft.items.find((item) => item.caseId === caseId)?.similarTo;

  it('частичная приёмка отдаёт черновик ровно как GET: похожие панели и коды предупреждений', async () => {
    const answered = await post('apply', { caseIds: ['gui-003'] });
    const read = await getDraft();
    // Предупреждения файл после записи уже не несёт (отброшенная правка не
    // пишется обратно) — сравнение по правкам, коды проверены отдельно.
    expect(answered.items).toEqual(read.items);
    expect(similarOf(answered, 'gui-002')).not.toEqual(AGENT_SIMILAR);
    expect(similarOf(answered, 'gui-002')?.[0]?.caseId).toBe('gui-001');
    expect(answered.warningsCodes?.[0]).toMatchObject({ messageCode: expect.any(String) });
  });

  it('отказ и откат — тоже без похожих агента и с кодами предупреждений', async () => {
    const rejected = await post('reject');
    expect(similarOf(rejected, 'gui-002')).not.toEqual(AGENT_SIMILAR);
    expect(rejected.warningsCodes?.[0]).toMatchObject({ messageCode: expect.any(String) });
  });

  it('откат приёмки — вид с похожими панели', async () => {
    await post('apply', { caseIds: ['gui-002'] });
    const rolled = await post('rollback');
    expect(similarOf(rolled, 'gui-002')).not.toEqual(AGENT_SIMILAR);
    expect(similarOf(rolled, 'gui-002')?.[0]?.caseId).toBe('gui-001');
  });
});
