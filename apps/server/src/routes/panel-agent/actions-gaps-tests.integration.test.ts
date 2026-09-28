import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ProjectTestManualRegistry, ProjectTestRunRegistry } from '../../domains/project-tests.ts';
import { registerProjectTestsRoutes } from '../project-tests-routes.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { manageHarness, type ManageHarness } from './manage-test-harness.ts';
import { folderSnapshot } from './registered-folder.test-kit.ts';

/**
 * Раздел «Тесты» дорожки A на настоящих маршрутах раздела и файлах временного
 * проекта: черновик дефекта, статусы дефектов, черновики тестов, папка e2e и
 * группы по умолчанию. Доказательство — файлы проекта и ответ маршрута, отказ
 * до карточки у чужой папки и у «ничего не изменится».
 */
const DRAFT_RUN = 'c3d4e5f6-0000-4000-8000-00000000a001';
const SECRET = `ghp_${'Z9y8X7w6'.repeat(4)}`;

describe('panel-agent actions: tests gaps (lane A)', () => {
  let appData: string;
  let projectDir: string;
  let outside: string;
  let h: ManageHarness;

  const testsDir = (): string => join(projectDir, '.agent', 'tests');
  const groupFile = (): string => join(testsDir(), 'gui.tests.json');

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-gaps-t-appdata-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-agent-gaps-t-project-'));
    outside = mkdtempSync(join(tmpdir(), 'cc-agent-gaps-t-outside-'));
    mkdirSync(join(testsDir(), 'drafts'), { recursive: true });
    writeFileSync(
      groupFile(),
      JSON.stringify({
        version: 1,
        title: 'GUI',
        cases: [
          {
            id: 'gui-001',
            type: 'case',
            title: 'Вход в панель',
            steps: [{ action: 'Открыть', expected: `Открыто, токен ${SECRET}` }],
            status: 'failed',
            source: 'human',
            defects: [{ url: 'https://tracker.example.com/browse/PROJ-7', title: 'Вход' }],
          },
        ],
      }),
    );
    writeFileSync(
      join(testsDir(), 'drafts', `${DRAFT_RUN}.draft.json`),
      JSON.stringify({
        version: 1,
        runId: DRAFT_RUN,
        createdAt: '2026-09-28T09:00:00.000Z',
        items: [
          {
            op: 'add',
            groupId: 'gui',
            caseId: 'gui-010',
            case: {
              id: 'gui-010',
              type: 'case',
              title: 'Новый кейс',
              steps: [{ action: 'Открыть' }],
              status: 'unknown',
              source: 'agent',
            },
          },
        ],
      }),
    );
    const store = new AppStore(appData);
    store.addProject({ id: 'p-gaps', name: 'Gaps', path: projectDir });
    const ctx = {
      store,
      location: { paths: { root: appData, appData, settings: join(appData, 'settings.json') } },
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;
    h = await manageHarness(ctx, (app) => {
      registerProjectRoutes(app, ctx);
      registerProjectTestsRoutes(
        app,
        ctx,
        new ProjectTestRunRegistry(),
        new ProjectTestManualRegistry(),
      );
    });
  });

  afterEach(async () => {
    await h.close();
    for (const dir of [appData, projectDir, outside]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('draft_defect: draft from the case, secret masked, nothing filed; unknown case and foreign folder refused', async () => {
    const before = folderSnapshot(projectDir);
    const out = await h.call('draft_defect', {
      projectPath: projectDir,
      groupId: 'gui',
      caseId: 'gui-001',
    });
    expect(out.outcome, out.message).toBe('done');
    const draft = out.result as { title: string; body: { text: string }; targets: string[] };
    expect(draft.title).toContain('Вход в панель');
    expect(JSON.stringify(draft)).not.toContain(SECRET);
    expect(Array.isArray(draft.targets)).toBe(true);
    // Черновик — не запись: файлы проекта те же.
    expect(folderSnapshot(projectDir)).toEqual(before);

    const missing = await h.call('draft_defect', {
      projectPath: projectDir,
      groupId: 'gui',
      caseId: 'gui-404',
    });
    expect(missing.outcome).toBe('failed');

    const foreign = await h.call('draft_defect', {
      projectPath: outside,
      groupId: 'gui',
      caseId: 'gui-001',
    });
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('not registered');
  });

  it('refresh_defect_states: card counts the linked defects; approve asks the trackers; no defects — refused before a card', async () => {
    const rejected = await h.decided(
      'refresh_defect_states',
      { projectPath: projectDir },
      'reject',
    );
    expect(rejected.result.outcome).toBe('rejected');

    const { card, result } = await h.decided('refresh_defect_states', {
      projectPath: projectDir,
    });
    expect(card.preview.summaryCode).toBe('summary-refresh-defect-states');
    expect(card.preview.fields.find((f) => f.labelCode === 'label-defects-tracked')?.value).toBe(
      '1',
    );
    expect(result.outcome, result.message).toBe('done');
    // Jira не подключена: ответа нет, причина названа, а не выдуман статус.
    const refreshed = result.result as { checked: number; skipped: string[] };
    expect(refreshed.checked).toBe(0);
    expect(refreshed.skipped.length).toBeGreaterThan(0);

    const file = JSON.parse(readFileSync(groupFile(), 'utf8')) as {
      cases: Array<{ defects?: unknown[] }>;
    };
    delete file.cases[0]!.defects;
    writeFileSync(groupFile(), JSON.stringify({ version: 1, title: 'GUI', ...file }));
    const none = await h.call('refresh_defect_states', { projectPath: projectDir });
    expect(none.outcome).toBe('failed');
    expect(none.message).toContain('No defect');
    expect(await h.pendingCards()).toEqual([]);
  });

  it('list_test_drafts: list, one draft’s proposed cases; foreign folder refused', async () => {
    const list = await h.call('list_test_drafts', { projectPath: projectDir });
    expect(list.outcome, list.message).toBe('done');
    expect(list.result).toMatchObject({
      drafts: [{ runId: DRAFT_RUN, status: 'pending', items: 1 }],
    });
    const one = await h.call('list_test_drafts', { projectPath: projectDir, runId: DRAFT_RUN });
    expect(one.result).toMatchObject({
      proposed: [{ op: 'add', caseId: 'gui-010', title: 'Новый кейс' }],
    });
    const foreign = await h.call('list_test_drafts', { projectPath: outside });
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('not registered');
  });

  it('create_e2e_folder / remove_e2e_folder: scaffold appears and goes only by approval; own folder is never removed', async () => {
    const e2e = join(projectDir, 'e2e');
    const rejected = await h.decided('create_e2e_folder', { projectPath: projectDir }, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(existsSync(e2e)).toBe(false);

    const created = await h.decided('create_e2e_folder', { projectPath: projectDir });
    expect(created.card.preview.summaryCode).toBe('summary-create-e2e-folder');
    expect(created.result.outcome, created.result.message).toBe('done');
    expect(created.result.result).toMatchObject({ e2e: { state: 'created', dir: 'e2e' } });
    expect(existsSync(e2e)).toBe(true);

    const again = await h.call('create_e2e_folder', { projectPath: projectDir });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('Nothing would change');

    const removed = await h.decided('remove_e2e_folder', { projectPath: projectDir });
    expect(removed.card.risk).toBe('danger');
    expect(removed.result.outcome, removed.result.message).toBe('done');
    expect(existsSync(e2e)).toBe(false);

    // Своя папка проекта: панель её не заводила — отказ до карточки, папка на месте.
    mkdirSync(join(projectDir, 'tests', 'e2e'), { recursive: true });
    writeFileSync(join(projectDir, 'tests', 'e2e', 'login.spec.ts'), 'test("x", () => {});\n');
    const own = await h.call('remove_e2e_folder', { projectPath: projectDir });
    expect(own.outcome).toBe('failed');
    expect(existsSync(join(projectDir, 'tests', 'e2e', 'login.spec.ts'))).toBe(true);

    const foreign = await h.call('create_e2e_folder', { projectPath: outside });
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('not registered');
    expect(existsSync(join(outside, 'e2e'))).toBe(false);
  });

  it('list_default_test_groups: the starting groups of a new library', async () => {
    const out = await h.call('list_default_test_groups', {});
    expect(out.outcome, out.message).toBe('done');
    const groups = (out.result as { groups: Array<{ id: string; title: string }> }).groups;
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((group) => group.id && group.title)).toBe(true);
  });
});
