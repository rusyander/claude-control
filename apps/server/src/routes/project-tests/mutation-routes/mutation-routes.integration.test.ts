import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestMutationView } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  E2eRunRegistry,
  MutationChecks,
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
} from '../../../domains/project-tests/project-tests.ts';
import { registerProjectTestsRoutes } from '../../project-tests-routes/project-tests-routes.ts';

/**
 * Маршруты проверки поломкой (Ф20, Ф11) через Fastify: чужой каталог — 403,
 * настоящая проверка в копии доходит до итога, вторая — 409, а проверка и
 * автотесты одного проекта не идут одновременно ни в какую сторону.
 * Проверка — настоящая (`git worktree`, команда `automation.json`); автотесты
 * «идут» подменой `isRunning` — их раннер здесь не предмет.
 */

const MATH = 'export const add = (a, b) => a + b;\n';
const CHECK = `import { writeFileSync } from 'node:fs';
let status = 'passed';
try {
  const math = await import('./src/math.mjs');
  if (math.add(2, 2) !== 4) status = 'failed';
} catch {
  status = 'failed';
}
const row = status === 'passed' ? '<testcase name="[math-001] add"/>' : '<testcase name="[math-001] add"><failure message="x"/></testcase>';
writeFileSync(process.env.AGENTDECK_JUNIT_REPORT, '<?xml version="1.0"?><testsuite>' + row + '</testsuite>');
`;

class BusyE2e extends E2eRunRegistry {
  busy = false;
  override isRunning(root: string): boolean {
    return this.busy || super.isRunning(root);
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
}

describe('project-tests mutation routes', () => {
  let app: FastifyInstance;
  let base = '';
  let project = '';
  let appData = '';
  let e2eRuns: BusyE2e;
  let mutations: MutationChecks;

  beforeEach(async () => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-mutation-routes-')));
    project = join(base, 'repo');
    appData = join(base, 'data');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(project, '.agent', 'tests'), { recursive: true });
    mkdirSync(appData);
    writeFileSync(join(project, 'src', 'math.mjs'), MATH);
    writeFileSync(join(project, 'check.mjs'), CHECK);
    writeFileSync(join(project, '.gitignore'), '.agent\n');
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ command: 'node check.mjs' }),
    );
    writeFileSync(
      join(project, '.agent', 'tests', 'math.tests.json'),
      JSON.stringify({
        title: 'Math',
        cases: [
          {
            id: 'math-001',
            title: 'add',
            steps: [],
            automation: { status: 'automated', file: 'check.mjs' },
            codePaths: ['src/math.mjs'],
          },
        ],
      }),
    );
    git(project, ['init', '-q', '-b', 'main']);
    git(project, ['add', '.']);
    git(project, ['commit', '-q', '-m', 'init']);
    const store = new AppStore(appData);
    store.addProject({ id: 'p-mutation', name: 'proj', path: project });
    const ctx = {
      store,
      backupDir: join(appData, 'backups'),
      location: { paths: { root: appData, appData, settings: join(appData, 'settings.json') } },
    } as unknown as ServerContext;
    e2eRuns = new BusyE2e();
    mutations = new MutationChecks();
    app = Fastify();
    registerProjectTestsRoutes(
      app,
      ctx,
      new ProjectTestRunRegistry(),
      new ProjectTestManualRegistry(),
      {
        e2eRuns,
        mutations,
      },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const start = (path = project) =>
    app.inject({
      method: 'POST',
      url: '/api/project-tests/mutation',
      payload: { path, file: 'src/math.mjs' },
    });
  const read = async (): Promise<ProjectTestMutationView> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/project-tests/mutation?path=${encodeURIComponent(project)}`,
      })
    ).json<ProjectTestMutationView>();

  it('кандидаты → проверка в копии до итога; вторая, пока идёт первая, — 409', async () => {
    expect((await read()).candidates).toEqual([{ file: 'src/math.mjs', cases: 1 }]);

    const first = await start();
    expect(first.statusCode).toBe(200);
    expect(first.json<ProjectTestMutationView>().check).toMatchObject({ status: 'running' });
    const second = await start();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ messageCode: 'mutation-busy' });

    await vi.waitFor(async () => expect((await read()).check?.status).toBe('done'), {
      timeout: 60_000,
      interval: 200,
    });
    expect((await read()).check).toMatchObject({ caught: 1, missed: 0, noResult: 0 });
    // Рабочая копия человека нетронута, копия снята.
    expect(readFileSync(join(project, 'src', 'math.mjs'), 'utf8')).toBe(MATH);
    expect(git(project, ['worktree', 'list']).split('\n')).toHaveLength(1);
  }, 90_000);

  it('каталог не из реестра — 403, команда не исполняется', async () => {
    const foreign = join(base, 'foreign');
    mkdirSync(foreign);
    const refused = await start(foreign);
    expect(refused.statusCode).toBe(403);
    expect(mutations.status(foreign)).toBeUndefined();
  });

  it('идут автотесты проекта — проверка поломкой 409 с причиной (Ф11)', async () => {
    e2eRuns.busy = true;
    const refused = await start();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ messageCode: 'mutation-e2e-running' });
    expect(mutations.status(project)).toBeUndefined();
  });

  it('идёт проверка поломкой — прогон автотестов 409; остановка снимает замок (Ф11)', async () => {
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ command: 'node -e "setTimeout(() => {}, 30000)"' }),
    );
    expect((await start()).statusCode).toBe(200);
    const refused = await app.inject({
      method: 'POST',
      url: '/api/project-tests/e2e/run',
      payload: { path: project },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ messageCode: 'e2e-run-mutation-running' });

    const stopped = await app.inject({
      method: 'POST',
      url: '/api/project-tests/mutation/stop',
      payload: { path: project },
    });
    expect(stopped.statusCode).toBe(200);
    await vi.waitFor(() => expect(mutations.isRunning(project)).toBe(false), {
      timeout: 60_000,
      interval: 200,
    });
    expect((await read()).check?.status).toBe('stopped');
    expect(git(project, ['worktree', 'list']).split('\n')).toHaveLength(1);
  }, 90_000);
});
