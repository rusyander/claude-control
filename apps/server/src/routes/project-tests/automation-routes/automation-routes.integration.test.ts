import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  ProjectTestAdoptResult,
  ProjectTestAutomationInfo,
  ProjectTestsView,
} from '@agentdeck/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../../../context.ts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import {
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
} from '../../../domains/project-tests/project-tests.ts';
import { registerProjectTestsRoutes } from '../../project-tests-routes/project-tests-routes.ts';

/**
 * Своя команда бэкенда через HTTP, кругом: рецепт по файлам проекта → запись →
 * НАСТОЯЩИЙ прогон через оболочку (вывод `go test -json` из записанного
 * прогона) → «Завести кейсы» → следующий прогон ложится на кейсы → снятие.
 * Сам `go` тесту не нужен: вопрос — путь панели от команды до кейсов.
 */
const GO_FIXTURE = fileURLToPath(
  new URL('../../../domains/project-tests/automation/__fixtures__/go-test.json', import.meta.url),
);

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Остаётся в temp — на результат не влияет.
  }
}

describe('project-tests automation routes', () => {
  let app: FastifyInstance;
  let project = '';
  let appData = '';
  let emitter = '';

  const put = (path: string, body = ''): void => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), body);
  };

  beforeEach(async () => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-automation-routes-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-automation-routes-data-')));
    put('go.mod', 'module example.com/goshop\n');
    put(
      'orders/orders_test.go',
      'package orders\n\nfunc TestTotal(t *testing.T) {}\nfunc TestTotalBroken(t *testing.T) {}\nfunc TestSkipped(t *testing.T) {}\n',
    );
    put('orders/table_test.go', 'package orders\n\nfunc TestTable(t *testing.T) {}\n');
    // Подставной `go test -json`: печатает записанный вывод настоящего прогона,
    // а с аргументом hang — висит, пока его не остановят.
    emitter = join(appData, 'emit.mjs');
    writeFileSync(
      emitter,
      `import { readFileSync } from 'node:fs';\n` +
        `if (process.argv[2] === 'hang') setInterval(() => {}, 1000);\n` +
        `else process.stdout.write(readFileSync(${JSON.stringify(GO_FIXTURE)}));\n`,
    );
    const store = new AppStore(appData);
    store.addProject({ id: 'p-go', name: 'goshop', path: project });
    const ctx = {
      store,
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
    dropTemp(project);
    dropTemp(appData);
  });

  const info = async (): Promise<ProjectTestAutomationInfo> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/project-tests/automation?path=${encodeURIComponent(project)}`,
      })
    ).json<ProjectTestAutomationInfo>();
  const view = async (): Promise<ProjectTestsView> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/project-tests?path=${encodeURIComponent(project)}`,
      })
    ).json<ProjectTestsView>();
  const save = (payload: Record<string, unknown>, path = project) =>
    app.inject({
      method: 'PUT',
      url: '/api/project-tests/automation',
      payload: { path, ...payload },
    });
  const runToEnd = async (): Promise<ProjectTestsView> => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/project-tests/e2e/run',
      payload: { path: project },
    });
    expect(started.statusCode, started.body).toBe(200);
    await vi.waitFor(async () => expect((await view()).e2eRun?.finishedAt).toBeDefined(), {
      timeout: 20_000,
    });
    return view();
  };
  const adopt = () =>
    app.inject({ method: 'POST', url: '/api/project-tests/e2e/adopt', payload: { path: project } });

  it('рецепт → запись → прогон → «Завести кейсы» → прогон на кейсах → снятие', async () => {
    const empty = await info();
    expect(empty.automation).toBeUndefined();
    expect(empty.recipes[0]).toMatchObject({
      id: 'go:',
      automation: { command: 'go test -json {packages} > {report}', format: 'go-test-json' },
    });

    // Запись — те же правила, что чтение; чужой каталог — отказ, а не запись.
    const multiline = await save({ command: 'a\nb' });
    expect(multiline.statusCode).toBe(400);
    expect(multiline.json()).toMatchObject({ messageCode: 'automation-command-multiline' });
    const stranger = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-automation-stranger-')));
    try {
      expect((await save({ command: 'go test ./...' }, stranger)).statusCode).toBe(403);
      expect(existsSync(join(stranger, '.agent'))).toBe(false);
    } finally {
      dropTemp(stranger);
    }

    const saved = await save({
      command: `node "${emitter}" > {report}`,
      format: 'go-test-json',
      report: '',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await info()).automation).toEqual({
      command: `node "${emitter}" > {report}`,
      format: 'go-test-json',
    });

    // Первый прогон: семь результатов, ни одного кейса; «(build)» в кнопку не входит.
    const first = await runToEnd();
    expect(first.e2eRun).toMatchObject({
      status: 'done',
      imported: { read: 7, matched: 0, unmatched: 7 },
      adoptable: 6,
      own: true,
      buildFailed: 1,
    });
    // Имена — только тестов: несобравшийся пакет итог называет своей строкой.
    expect(first.e2eRun?.unmatchedNames).not.toContain('(build)');

    const adopted = await adopt();
    expect(adopted.statusCode, adopted.body).toBe(200);
    const body = adopted.json<{ adopt: ProjectTestAdoptResult; view: ProjectTestsView }>();
    expect(body.adopt).toMatchObject({ added: 6, skipped: 0 });
    expect(body.view.e2eRun?.adoptable).toBeUndefined();
    expect(body.view.e2eRun?.adopted).toBe(6);
    const cases = body.view.groups.flatMap((group) => group.cases);
    expect(cases).toHaveLength(6);
    // Кнопку нажали со второго экрана — пусто, а не те же кейсы ещё раз.
    expect((await adopt()).json<{ adopt: ProjectTestAdoptResult }>().adopt.added).toBe(0);

    const second = await runToEnd();
    expect(second.e2eRun).toMatchObject({
      status: 'done',
      imported: { read: 7, matched: 6, unmatched: 1 },
      buildFailed: 1,
    });
    expect(second.e2eRun?.adoptable).toBeUndefined();
    expect(second.e2eRun?.adopted).toBeUndefined();
    const status = Object.fromEntries(
      second.groups.flatMap((group) => group.cases).map((item) => [item.title, item.status]),
    );
    expect(status).toMatchObject({
      TestTotal: 'passed',
      TestTotalBroken: 'failed',
      TestSkipped: 'skipped',
    });

    // Посреди прогона команда не меняется и не снимается: итог подписал бы чужую строку.
    expect((await save({ command: `node "${emitter}" hang` })).statusCode).toBe(200);
    const hanging = await app.inject({
      method: 'POST',
      url: '/api/project-tests/e2e/run',
      payload: { path: project },
    });
    expect(hanging.json<ProjectTestsView>().e2eRun?.status).toBe('running');
    const busy = await save({ command: 'go test ./...' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ messageCode: 'e2e-run-busy' });
    const busyRemove = await app.inject({
      method: 'DELETE',
      url: `/api/project-tests/automation?path=${encodeURIComponent(project)}`,
    });
    expect(busyRemove.statusCode).toBe(409);
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/e2e/run/stop',
      payload: { path: project },
    });
    await vi.waitFor(async () => expect((await view()).e2eRun?.finishedAt).toBeDefined(), {
      timeout: 20_000,
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/project-tests/automation?path=${encodeURIComponent(project)}`,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await info()).automation).toBeUndefined();
    expect(existsSync(join(project, '.agent', 'tests', 'automation.removed.json'))).toBe(true);
  }, 60_000);
});
