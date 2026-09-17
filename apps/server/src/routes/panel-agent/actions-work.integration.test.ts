import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { registerProjectGitRoutes } from '../project-git-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Проекты вне чата: снятие с учёта, состояние git и рабочие копии — на настоящих
 * маршрутах и настоящем git во ВРЕМЕННОМ репозитории. Плюс D5: страница после
 * создания проекта — его карточка или чат, по выбору.
 */
const ORIGIN = 'http://localhost:8888';

const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe('panel-agent actions: projects outside chat', () => {
  let appData: string;
  let projectDir: string;
  let store: AppStore;
  let pending: PanelPendingActions;
  let app: FastifyInstance;

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-work-appdata-'));
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-agent-work-project-')));
    store = new AppStore(appData);
    pending = new PanelPendingActions(10_000);
    const ctx = {
      store,
      location: { paths: { appData, root: appData } },
      effectiveSettings: () => store.getSettings(),
      // Бутстрапов копий в тесте нет: копию заводит git, а не маршрут.
      worktreeBootstraps: { status: () => undefined },
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerProjectRoutes(app, ctx);
    registerProjectGitRoutes(app, ctx, new ChatRunRegistry());
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    for (const dir of [appData, projectDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const call = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-work' },
    });

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const [first] = (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json<
        PanelPendingAction[]
      >();
      if (first) return first;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const decided = async (name: string, input: unknown) => {
    const running = call(name, input);
    const card = await waitPending();
    const decision = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });
    expect(decision.statusCode).toBe(200);
    return { card, result: (await running).json<PanelActionResult>() };
  };

  it('D5: create_project с open=chat ведёт в чат проекта; delete_project снимает с учёта, файлы на месте', async () => {
    writeFileSync(join(projectDir, 'README.md'), 'hello\n');
    const created = await decided('create_project', {
      path: projectDir,
      name: 'Рабочий',
      open: 'chat',
    });
    const project = new AppStore(appData).getProjects()[0];
    expect(project?.name).toBe('Рабочий');
    expect(created.result).toMatchObject({
      outcome: 'done',
      page: { route: '/chat', focus: `project:${project!.id}` },
    });

    const removed = await decided('delete_project', { project: project!.id });
    expect(removed.card.risk).toBe('danger');
    expect(removed.result.outcome).toBe('done');
    expect(new AppStore(appData).getProjects()).toEqual([]);
    expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe('hello\n');
  });

  it('delete_project неизвестного — отказ без карточки', async () => {
    const result = (await call('delete_project', { project: 'nope' })).json<PanelActionResult>();
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('not registered');
  });

  it.skipIf(!GIT_AVAILABLE)(
    'project_git_status и list_worktrees: ветка, изменённый файл, копия рядом',
    async () => {
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: projectDir, stdio: 'ignore', windowsHide: true });
      };
      git('init', '--initial-branch=main');
      git('config', 'user.email', 'qa@example.com');
      git('config', 'user.name', 'QA');
      writeFileSync(join(projectDir, 'a.txt'), 'one\n');
      git('add', 'a.txt');
      git('commit', '-m', 'init');
      writeFileSync(join(projectDir, 'a.txt'), 'two\n');

      const status = (
        await call('project_git_status', { projectPath: projectDir })
      ).json<PanelActionResult>();
      expect(status.outcome).toBe('done');
      expect(status.result).toMatchObject({ isRepo: true, branch: 'main' });
      expect(JSON.stringify(status.result)).toContain('a.txt');

      const copy = join(`${projectDir}-worktrees`, 'feature');
      mkdirSync(`${projectDir}-worktrees`, { recursive: true });
      git('worktree', 'add', '-b', 'feature', copy);
      try {
        const trees = (
          await call('list_worktrees', { projectPath: projectDir })
        ).json<PanelActionResult>();
        expect(trees.outcome).toBe('done');
        const list = (trees.result as { worktrees: Array<{ branch?: string; isMain: boolean }> })
          .worktrees;
        expect(list.map((item) => [item.branch, item.isMain])).toEqual(
          expect.arrayContaining([
            ['main', true],
            ['feature', false],
          ]),
        );
      } finally {
        git('worktree', 'remove', '--force', copy);
        rmSync(`${projectDir}-worktrees`, { recursive: true, force: true });
      }
    },
  );
});
