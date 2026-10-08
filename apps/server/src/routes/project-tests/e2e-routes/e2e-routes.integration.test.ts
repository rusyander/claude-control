import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ProjectAdded,
  ProjectTestE2eSync,
  ProjectTestRun,
  ProjectTestRunRequest,
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
import { registerProjectRoutes } from '../../project-routes/project-routes.ts';
import { playwrightFileArg } from '../../../domains/project-tests/e2e-command/e2e-command.ts';
import {
  installFakeRunners,
  markRunnerInstalled,
} from '../../../domains/project-tests/__fixtures__/fake-runners.ts';

/**
 * Папка e2e через HTTP на настоящем репозитории во временном каталоге: вид
 * раздела знает о папке, заведение прячет её от git, уборка возвращает проект
 * байт в байт, сверка превращает тесты в кейсы, а добавление проекта в реестр
 * само забирает его тесты.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Остаётся в temp — на результат не влияет.
  }
}

const SPEC = `import { test } from '@playwright/test';
test.describe('Корзина', () => {
  test('[cart-001] добавить товар @smoke', async () => {
    // Given каталог открыт
    // When нажимает «В корзину»
    // Then счётчик корзины = 1
  });
  test('пустая корзина', async () => {});
});
`;

/** Байты проекта вне `.git` плюс файл исключений. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path === join(root, '.git')) continue;
        out[`${relative(root, path)}/`] = 'dir';
        walk(path);
      } else out[relative(root, path)] = readFileSync(path, 'latin1');
    }
  };
  walk(root);
  const exclude = join(root, '.git', 'info', 'exclude');
  out.exclude = existsSync(exclude) ? readFileSync(exclude, 'latin1') : '<none>';
  return out;
}

/** Реестр прогонов, который только запоминает заявку: CLI в тесте не запускается. */
class RecordingRuns extends ProjectTestRunRegistry {
  private readonly sink: ProjectTestRunRequest[];

  constructor(sink: ProjectTestRunRequest[]) {
    super();
    this.sink = sink;
  }

  override start(
    request: ProjectTestRunRequest,
    ...rest: Parameters<ProjectTestRunRegistry['start']> extends [unknown, ...infer R] ? R : never
  ): ProjectTestRun {
    // Папку e2e заводит сам реестр после своих отказов — заглушка держит тот же
    // договор, иначе маршрут, отдавший её реестру, выглядел бы не заводящим.
    if (request.mode === 'generate' && request.e2e) rest[3]?.ensureE2e?.();
    this.sink.push(request);
    return {} as ProjectTestRun;
  }

  /** Прогон агента «держит» проект — так тест ставит конфликт с автотестами. */
  holding: string | undefined;

  override holds(projectPath: string, groupId?: string): string | undefined {
    return this.holding ?? super.holds(projectPath, groupId);
  }
}

const REGISTERED = 'p-e2e';

/** Коммит, от которого растут копии ветки: `worktree add` без него не работает. */
function commitAll(cwd: string): void {
  spawnSync('git', ['add', '-A'], { cwd });
  spawnSync(
    'git',
    ['-c', 'user.email=qa@example.com', '-c', 'user.name=qa', 'commit', '-qm', 'init'],
    {
      cwd,
    },
  );
}

describe('project-tests e2e routes', () => {
  let app: FastifyInstance;
  let started: ProjectTestRunRequest[] = [];
  let runs: RecordingRuns;
  let project = '';
  let appData = '';
  let store: AppStore;

  beforeEach(async () => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-routes-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-routes-data-')));
    spawnSync('git', ['init', '-q'], { cwd: project });
    writeFileSync(join(project, 'index.html'), '<h1>app</h1>\n');
    store = new AppStore(appData);
    // Проект раздела — в реестре: папку e2e и прогон автотестов панель заводит
    // только у своих проектов и их копий.
    store.addProject({ id: REGISTERED, name: 'proj', path: project });
    const ctx = {
      store,
      backupDir: join(appData, 'backups'),
      location: {
        paths: { root: appData, appData, settings: join(appData, 'settings.json') },
      },
    } as unknown as ServerContext;
    app = Fastify();
    started = [];
    runs = new RecordingRuns(started);
    registerProjectTestsRoutes(app, ctx, runs, new ProjectTestManualRegistry());
    registerProjectRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(project);
    dropTemp(appData);
  });

  const view = async (): Promise<ProjectTestsView> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/project-tests?path=${encodeURIComponent(project)}`,
      })
    ).json<ProjectTestsView>();

  it('завести → скрыта от git → убрать: проект байт в байт как до панели', async () => {
    const before = snapshot(project);
    expect((await view()).e2e).toMatchObject({ state: 'missing', git: true });

    const created = await app.inject({
      method: 'POST',
      url: '/api/project-tests/e2e',
      payload: { path: project },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json<ProjectTestsView>().e2e).toMatchObject({
      state: 'created',
      dir: 'e2e',
      excluded: true,
      framework: 'playwright',
    });
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: project,
      encoding: 'utf8',
    }).stdout;
    expect(status).toContain('index.html');
    expect(status).not.toContain('e2e');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/project-tests/e2e?path=${encodeURIComponent(project)}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<ProjectTestsView>().e2e?.state).toBe('missing');
    expect(snapshot(project)).toEqual(before);
  });

  it('чужие файлы: 409 с кодом и счётом, force=1 убирает всё', async () => {
    const before = snapshot(project);
    await app.inject({ method: 'POST', url: '/api/project-tests/e2e', payload: { path: project } });
    writeFileSync(join(project, 'e2e', 'cart.spec.ts'), SPEC);
    // Выводимое не в счёт: зависимости, отчёт и замок установки — не чья-то работа.
    mkdirSync(join(project, 'e2e', 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(project, 'e2e', 'node_modules', '.bin', 'playwright'), '');
    mkdirSync(join(project, 'e2e', 'test-results'));
    writeFileSync(join(project, 'e2e', 'test-results', 'last-run.json'), '{}');
    writeFileSync(join(project, 'e2e', 'package-lock.json'), '{}');
    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/project-tests/e2e?path=${encodeURIComponent(project)}`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      messageCode: 'e2e-folder-not-empty',
      params: { count: 1 },
    });
    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/project-tests/e2e?path=${encodeURIComponent(project)}&force=1`,
    });
    expect(forced.statusCode).toBe(200);
    expect(snapshot(project)).toEqual(before);
  });

  it('заготовка с установленными зависимостями убирается без подтверждения', async () => {
    const before = snapshot(project);
    await app.inject({ method: 'POST', url: '/api/project-tests/e2e', payload: { path: project } });
    mkdirSync(join(project, 'e2e', 'node_modules', '@playwright', 'test'), { recursive: true });
    writeFileSync(join(project, 'e2e', 'node_modules', '@playwright', 'test', 'index.js'), '');
    writeFileSync(join(project, 'e2e', 'package-lock.json'), '{}');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/project-tests/e2e?path=${encodeURIComponent(project)}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(snapshot(project)).toEqual(before);
  });

  it('своя папка: убрать нельзя (404), сверка заводит кейсы и отвечает видом', async () => {
    mkdirSync(join(project, 'tests', 'e2e'), { recursive: true });
    writeFileSync(join(project, 'tests', 'e2e', 'cart.spec.ts'), SPEC);
    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/project-tests/e2e?path=${encodeURIComponent(project)}`,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ messageCode: 'e2e-not-created' });

    const synced = await app.inject({
      method: 'POST',
      url: '/api/project-tests/e2e/sync',
      payload: { path: project },
    });
    expect(synced.statusCode).toBe(200);
    const body = synced.json<{ sync: ProjectTestE2eSync; view: ProjectTestsView }>();
    expect(body.sync).toMatchObject({ dir: 'tests/e2e', added: 2, groups: ['cart'] });
    const cart = body.view.groups.find((group) => group.id === 'cart');
    expect(cart?.cases.map((item) => item.id)).toEqual(['cart-001', 'cart-002']);
    expect(body.view.e2e).toMatchObject({ state: 'found', specs: 1 });
  });

  it('монорепозиторий: сверка с dir запоминает выбор; папка со стороны — 400', async () => {
    for (const name of ['admin', 'web']) {
      mkdirSync(join(project, 'apps', name, 'e2e'), { recursive: true });
    }
    writeFileSync(join(project, 'apps', 'admin', 'e2e', 'login.spec.ts'), SPEC);
    writeFileSync(join(project, 'apps', 'web', 'e2e', 'cart.spec.ts'), SPEC);
    expect((await view()).e2e).toMatchObject({
      dir: 'apps/admin/e2e',
      candidates: ['apps/web/e2e'],
    });

    const sync = (dir: string) =>
      app.inject({
        method: 'POST',
        url: '/api/project-tests/e2e/sync',
        payload: { path: project, dir },
      });
    const picked = await sync('apps/web/e2e/');
    expect(picked.statusCode).toBe(200);
    const body = picked.json<{ sync: ProjectTestE2eSync; view: ProjectTestsView }>();
    expect(body.sync).toMatchObject({ dir: 'apps/web/e2e', groups: ['cart'] });
    expect(body.view.e2e).toMatchObject({ dir: 'apps/web/e2e', candidates: ['apps/admin/e2e'] });
    // Выбор переживает запрос: следующая сверка без dir идёт по той же папке.
    expect((await view()).e2e?.dir).toBe('apps/web/e2e');

    const outside = await sync('../elsewhere');
    expect(outside.statusCode).toBe(400);
    expect(outside.json()).toMatchObject({
      messageCode: 'e2e-dir-unknown',
      params: { dir: '../elsewhere' },
    });
    expect((await view()).e2e?.dir).toBe('apps/web/e2e');
  });

  it('e2e уходит в прогон только у генерации; генерация заводит папку', async () => {
    const post = (mode: string) =>
      app.inject({
        method: 'POST',
        url: '/api/project-tests/run',
        payload: { path: project, mode, e2e: true },
      });
    expect((await post('run')).statusCode).toBe(200);
    expect(started.at(-1)).toMatchObject({ mode: 'run', e2e: false });
    expect(existsSync(join(project, 'e2e'))).toBe(false);

    expect((await post('generate')).statusCode).toBe(200);
    expect(started.at(-1)).toMatchObject({ mode: 'generate', e2e: true });
    expect(existsSync(join(project, 'e2e', 'playwright.config.ts'))).toBe(true);
  });

  /**
   * F-16: завести папку и прогнать автотесты — это запись в чужой каталог и
   * запуск его команды. Годятся проект из реестра, каталог внутри него и копии
   * его ветки (и панельные `<проект>-worktrees/…`, и заведённые git руками где
   * угодно); любой другой существующий каталог — 403 с кодом, и на диске ничего.
   */
  it('папка e2e и автотесты — только у проекта из реестра и его копий', async () => {
    const outsider = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-outsider-')));
    const elsewhere = join(realpathSync.native(tmpdir()), `cc-e2e-copy-${Date.now()}`);
    const panelCopy = join(`${project}-worktrees`, 'feat');
    try {
      spawnSync('git', ['init', '-q'], { cwd: outsider });
      commitAll(project);
      spawnSync('git', ['worktree', 'add', '-q', '-b', 'feat', panelCopy], {
        cwd: project,
      });
      spawnSync('git', ['worktree', 'add', '-q', '-b', 'side', elsewhere], { cwd: project });
      mkdirSync(join(project, 'apps', 'web'), { recursive: true });

      const post = (url: string, path: string, extra: Record<string, unknown> = {}) =>
        app.inject({ method: 'POST', url, payload: { path, ...extra } });

      for (const url of ['/api/project-tests/e2e', '/api/project-tests/e2e/run']) {
        const refused = await post(url, outsider);
        expect(refused.statusCode, url).toBe(403);
        expect(refused.json(), url).toMatchObject({ messageCode: 'e2e-project-unregistered' });
      }
      // Генерация кейсов работает в любом каталоге, но папку e2e и спеки она
      // заводит только у своего проекта: вне реестра — те же кейсы без e2e.
      const generate = await post('/api/project-tests/run', outsider, {
        mode: 'generate',
        e2e: true,
      });
      expect(generate.statusCode).toBe(200);
      expect(started).toEqual([expect.objectContaining({ mode: 'generate', e2e: false })]);
      expect(readdirSync(outsider).filter((name) => name !== '.git')).toEqual([]);

      for (const accepted of [project, join(project, 'apps', 'web'), panelCopy, elsewhere]) {
        const created = await post('/api/project-tests/e2e', accepted);
        expect(created.statusCode, accepted).toBe(200);
      }
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', elsewhere], { cwd: project });
      dropTemp(elsewhere);
      dropTemp(`${project}-worktrees`);
      dropTemp(outsider);
    }
  });

  it('сверка без папки — 400 с кодом', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/e2e/sync',
      payload: { path: project },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ messageCode: 'e2e-missing' });
  });

  it('добавление проекта: тесты своей папки сразу становятся кейсами', async () => {
    store.removeProject(REGISTERED);
    mkdirSync(join(project, 'e2e'));
    writeFileSync(join(project, 'e2e', 'cart.spec.ts'), SPEC);
    const added = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: project },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json<ProjectAdded>()).toMatchObject({
      path: project,
      e2e: { state: 'found', dir: 'e2e', sync: { tests: 2, added: 2, groups: ['cart'] } },
    });
    const groups = (await view()).groups;
    expect(groups.find((group) => group.id === 'cart')?.cases).toHaveLength(2);
  });

  it('добавление проекта без папки: панель заводит e2e/, скрытую от git', async () => {
    store.removeProject(REGISTERED);
    const added = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: project },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json<ProjectAdded>().e2e).toEqual({
      state: 'created',
      dir: 'e2e',
      excluded: true,
    });
    expect((await view()).e2e).toMatchObject({ state: 'created', excluded: true });
  });

  it('добавление проекта: своя папка без тестов — «нашлась», кейсов не заводит', async () => {
    store.removeProject(REGISTERED);
    mkdirSync(join(project, 'e2e'));
    writeFileSync(join(project, 'e2e', 'playwright.config.ts'), 'export default {};\n');
    const added = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: project },
    });
    expect(added.json<ProjectAdded>().e2e).toEqual({
      state: 'found',
      dir: 'e2e',
      framework: 'playwright',
    });
  });

  /**
   * Замок в обе стороны: автотесты на закрытии пишут в файлы групп, агент
   * раздела — тоже, а «Убрать вместе с ними» стёр бы спеки, которые агент
   * пишет прямо сейчас (или которые гоняет раннер).
   */
  it('пока идут автотесты: прогон агента и уборка папки — 409; пока идёт агент — уборка 409', async () => {
    const fake = installFakeRunners();
    const saved = process.env.FAKE_E2E_MODE;
    try {
      await app.inject({
        method: 'POST',
        url: '/api/project-tests/e2e',
        payload: { path: project },
      });
      writeFileSync(join(project, 'e2e', 'cart.spec.ts'), SPEC);
      markRunnerInstalled(join(project, 'e2e'), 'playwright');
      process.env.FAKE_E2E_MODE = 'hang';
      const e2eRun = await app.inject({
        method: 'POST',
        url: '/api/project-tests/e2e/run',
        payload: { path: project },
      });
      expect(e2eRun.json<ProjectTestsView>().e2eRun?.status).toBe('running');

      // Путь в другом написании — как его шлют агент панели и терминал.
      const agent = await app.inject({
        method: 'POST',
        url: '/api/project-tests/run',
        payload: { path: project.replace(/\\/g, '/'), mode: 'run' },
      });
      expect(agent.statusCode).toBe(409);
      expect(agent.json()).toMatchObject({ messageCode: 'e2e-run-busy' });
      expect(started).toEqual([]);

      const remove = (force: boolean) =>
        app.inject({
          method: 'DELETE',
          url: `/api/project-tests/e2e?path=${encodeURIComponent(project)}${force ? '&force=1' : ''}`,
        });
      const busy = await remove(true);
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ messageCode: 'e2e-run-busy' });
      expect(existsSync(join(project, 'e2e', 'cart.spec.ts'))).toBe(true);

      await app.inject({
        method: 'POST',
        url: '/api/project-tests/e2e/run/stop',
        payload: { path: project },
      });
      await vi.waitFor(async () => expect((await view()).e2eRun?.finishedAt).toBeDefined(), {
        timeout: 20_000,
      });

      runs.holding = 'agent-run-2';
      const locked = await remove(true);
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({ messageCode: 'group-run-in-progress' });
      expect(existsSync(join(project, 'e2e', 'cart.spec.ts'))).toBe(true);
      runs.holding = undefined;

      expect((await remove(true)).statusCode).toBe(200);
      expect(existsSync(join(project, 'e2e'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.FAKE_E2E_MODE;
      else process.env.FAKE_E2E_MODE = saved;
      fake.restore();
      dropTemp(fake.bin);
    }
  });

  it('прогнать автотесты: вид несёт ход и итог; поверх агента и поверх себя — 409', async () => {
    const fake = installFakeRunners();
    const saved = { mode: process.env.FAKE_E2E_MODE, junit: process.env.FAKE_E2E_JUNIT };
    try {
      await app.inject({
        method: 'POST',
        url: '/api/project-tests/e2e',
        payload: { path: project },
      });
      writeFileSync(join(project, 'e2e', 'cart.spec.ts'), SPEC);
      markRunnerInstalled(join(project, 'e2e'), 'playwright');
      await app.inject({
        method: 'POST',
        url: '/api/project-tests/e2e/sync',
        payload: { path: project },
      });
      const run = () =>
        app.inject({
          method: 'POST',
          url: '/api/project-tests/e2e/run',
          payload: { path: project },
        });

      runs.holding = 'agent-run-1';
      const locked = await run();
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({
        messageCode: 'group-run-in-progress',
        runId: 'agent-run-1',
      });
      runs.holding = undefined;

      process.env.FAKE_E2E_MODE = 'hang';
      const started = await run();
      expect(started.statusCode).toBe(200);
      expect(started.json<ProjectTestsView>().e2eRun).toMatchObject({ status: 'running' });
      const again = await run();
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ messageCode: 'e2e-run-busy' });
      const stopped = await app.inject({
        method: 'POST',
        url: '/api/project-tests/e2e/run/stop',
        payload: { path: project },
      });
      expect(stopped.json<ProjectTestsView>().e2eRun?.status).toBe('stopped');
      await vi.waitFor(async () => expect((await view()).e2eRun?.finishedAt).toBeDefined(), {
        timeout: 20_000,
      });

      process.env.FAKE_E2E_MODE = 'report';
      process.env.FAKE_E2E_JUNIT =
        '<testsuites><testsuite name="cart.spec.ts">' +
        '<testcase name="Корзина › [cart-001] добавить товар @smoke" classname="cart.spec.ts"/>' +
        '<testcase name="Корзина › пустая корзина" classname="cart.spec.ts"/>' +
        '</testsuite></testsuites>';
      expect((await run()).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await view()).e2eRun?.status).toBe('done'), {
        timeout: 20_000,
      });
      const done = await view();
      expect(done.e2eRun?.imported).toEqual({ read: 2, matched: 2, unmatched: 0 });
      const cart = done.groups.find((group) => group.id === 'cart');
      expect(cart?.cases.map((item) => item.status)).toEqual(['passed', 'passed']);

      // Выбор группы сужает прогон до её файлов; выбор без автотестов — 400 кодом.
      const scoped = await app.inject({
        method: 'POST',
        url: '/api/project-tests/e2e/run',
        payload: { path: project, groupId: 'cart', caseIds: ['cart-001', 7] },
      });
      expect(scoped.statusCode).toBe(200);
      expect(scoped.json<ProjectTestsView>().e2eRun?.command).toBe(
        `npx --no-install playwright test ${playwrightFileArg('e2e/cart.spec.ts')} --reporter=list,junit`,
      );
      await vi.waitFor(async () => expect((await view()).e2eRun?.status).toBe('done'), {
        timeout: 20_000,
      });
      const empty = await app.inject({
        method: 'POST',
        url: '/api/project-tests/e2e/run',
        payload: { path: project, groupId: 'no-such-group' },
      });
      expect(empty.statusCode).toBe(400);
      expect(empty.json()).toMatchObject({ messageCode: 'e2e-run-nothing-selected' });
    } finally {
      for (const [key, value] of Object.entries({
        FAKE_E2E_MODE: saved.mode,
        FAKE_E2E_JUNIT: saved.junit,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fake.restore();
      dropTemp(fake.bin);
    }
  });
});
