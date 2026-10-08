import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { WorktreeBootstraps } from '../../../domains/project-git/project-git.ts';
import { sandboxRoot } from '../../../domains/chat/ChatArtifacts/ChatArtifacts.ts';
import { registerProjectRoutes } from '../../project-routes/project-routes.ts';
import { registerProjectGitRoutes } from '../../project-git-routes/project-git-routes.ts';
import { registerProjectFilesRoutes } from '../../project-files-routes/project-files-routes.ts';
import { registerProjectLocalRoutes } from '../../project-local-routes.ts';
import { registerChatTranscriptRoutes } from '../../chat/transcript-routes/transcript-routes.ts';
import { manageHarness, type ManageHarness } from '../manage-test-harness.ts';

/**
 * Проектные чтения дорожки A на настоящих маршрутах окна проекта, настоящем
 * git (проект и его рабочая копия во временном каталоге), настоящих
 * транскриптах и настоящей установке копии (`node -e`, печатающий ключ).
 * Подмен нет: git читает свой конфиг из временного файла, не из профиля.
 */
const SECRET = `ghp_${'P0o9I8u7'.repeat(4)}`;

const drop = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // git на Windows держит хендлы дольше теста — каталог уйдёт из temp с ОС.
  }
};

const real = (dir: string): string => realpathSync.native(dir);

describe('panel-agent actions: project gaps (lane A)', () => {
  let root: string;
  let appData: string;
  let projectDir: string;
  let copyHome: string;
  let copyDir: string;
  let outside: string;
  let h: ManageHarness;
  const envBefore = {
    global: process.env.GIT_CONFIG_GLOBAL,
    nosystem: process.env.GIT_CONFIG_NOSYSTEM,
  };
  const ids = {
    main: randomUUID(),
    copy: randomUUID(),
    sandbox: randomUUID(),
    foreign: randomUUID(),
  };

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd,
      stdio: 'pipe',
      windowsHide: true,
    });

  const write = (path: string, content: string): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  };

  /** Разговор, где агент заменил строку в `a.ts` папки `cwd`. */
  const transcript = (id: string, cwd: string, edit: boolean): void => {
    const records: unknown[] = [
      {
        type: 'user',
        uuid: randomUUID(),
        sessionId: id,
        cwd,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: `Поправь a.ts в ${cwd}` },
      },
    ];
    if (edit) {
      records.push({
        type: 'assistant',
        uuid: randomUUID(),
        sessionId: id,
        cwd,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `tu-${id}`,
              name: 'Edit',
              input: {
                file_path: join(cwd, 'a.ts'),
                old_string: 'const a = 1;',
                new_string: 'const a = 10;',
              },
            },
          ],
        },
      });
    }
    write(
      join(root, 'projects', 'demo', `${id}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
  };

  beforeAll(async () => {
    root = real(mkdtempSync(join(tmpdir(), 'cc-agent-gaps-p-config-')));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const gitConfig = join(root, 'gitconfig');
    writeFileSync(gitConfig, '', 'utf8');
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';

    projectDir = real(mkdtempSync(join(tmpdir(), 'cc-agent-gaps-p-project-')));
    outside = real(mkdtempSync(join(tmpdir(), 'cc-agent-gaps-p-outside-')));
    copyHome = real(mkdtempSync(join(tmpdir(), 'cc-agent-gaps-p-copies-')));
    copyDir = join(copyHome, 'feature-x');

    write(join(projectDir, 'a.ts'), 'const a = 1;\n');
    // Собственный .claude проекта: скилл, хук с ключом, правило с маской путей.
    write(
      join(projectDir, '.claude', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Выкладка\n---\n',
    );
    write(
      join(projectDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: `curl -H "token ${SECRET}" x` }] }],
        },
      }),
    );
    write(
      join(projectDir, '.claude', 'rules', 'style.md'),
      '---\npaths: "src/**"\n---\n# Стиль\nПиши коротко.\n',
    );
    git(projectDir, 'init', '-q', '-b', 'main');
    git(projectDir, 'add', '-A');
    git(projectDir, 'commit', '-q', '-m', 'init');
    git(projectDir, 'worktree', 'add', '-q', '-b', 'feature/x', copyDir);
    copyDir = real(copyDir);
    // Правило, которого в проекте нет: чтение копии читает папку копии.
    write(join(copyDir, '.claude', 'rules', 'copy-only.md'), '# Только в копии\n');
    write(join(copyDir, 'a.ts'), 'const a = 10;\n');
    write(join(projectDir, 'a.ts'), 'const a = 10;\n');

    transcript(ids.main, projectDir, true);
    transcript(ids.copy, copyDir, true);
    transcript(ids.sandbox, join(sandboxRoot(), ids.sandbox), false);
    transcript(ids.foreign, outside, true);

    const store = new AppStore(appData);
    store.addProject({ id: 'p-demo', name: 'Demo', path: projectDir });
    const ctx = {
      store,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(appData, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
      worktreeBootstraps: new WorktreeBootstraps(join(appData, 'bootstrap')),
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;
    // Настоящая установка копии: процесс печатает ключ и кончается с кодом 0.
    const state = await ctx.worktreeBootstraps.run(
      copyDir,
      `node -e "console.log('installing with token ${SECRET}')"`,
    );
    expect(state.status).toBe('ok');

    h = await manageHarness(ctx, (app) => {
      registerProjectRoutes(app, ctx);
      registerProjectGitRoutes(app, ctx);
      registerProjectFilesRoutes(app, ctx);
      registerProjectLocalRoutes(app, ctx);
      registerChatTranscriptRoutes(app, ctx, () => false);
    });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    if (envBefore.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = envBefore.global;
    if (envBefore.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = envBefore.nosystem;
    for (const dir of [copyHome, projectDir, outside, root]) drop(dir);
    drop(join(sandboxRoot(), ids.sandbox));
  });

  it('read_project_changes: the agent’s edits in the project and in its copy; panel chat and foreign folder refused', async () => {
    const main = await h.call('read_project_changes', { chat: ids.main });
    expect(main.outcome, main.message).toBe('done');
    expect(main.result).toMatchObject({
      chat: ids.main,
      folder: projectDir,
      files: [{ path: 'a.ts', added: 1, removed: 1 }],
    });

    const copy = await h.call('read_project_changes', { chat: ids.copy });
    expect(copy.outcome, copy.message).toBe('done');
    expect(copy.result).toMatchObject({ folder: copyDir, files: [{ path: 'a.ts' }] });

    const sandbox = await h.call('read_project_changes', { chat: ids.sandbox });
    expect(sandbox.outcome).toBe('failed');
    expect(sandbox.message).toContain('lives in the panel itself');

    const foreign = await h.call('read_project_changes', { chat: ids.foreign });
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('not registered');
  });

  it('read_worktree_bootstrap_log: state and log of the real install, key masked; project itself and a non-copy refused', async () => {
    const out = await h.call('read_worktree_bootstrap_log', { project: 'p-demo', copy: copyDir });
    expect(out.outcome, out.message).toBe('done');
    const view = out.result as {
      state: { status: string; exitCode?: number; command: string };
      log: { text: string };
    };
    expect(view.state).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(view.log.text).toContain('installing with token');
    expect(JSON.stringify(out)).not.toContain(SECRET);

    const itself = await h.call('read_worktree_bootstrap_log', {
      project: 'p-demo',
      copy: projectDir,
    });
    expect(itself.outcome).toBe('failed');
    expect(itself.message).toContain('only copies have an install log');

    const notCopy = await h.call('read_worktree_bootstrap_log', {
      project: 'p-demo',
      copy: outside,
    });
    expect(notCopy.outcome).toBe('failed');
    expect(notCopy.message).toContain('is not a working copy');
  });

  it('read_project_local_config: the project’s own .claude and the copy’s, hook key masked; foreign folder refused', async () => {
    const own = await h.call('read_project_local_config', { project: projectDir });
    expect(own.outcome, own.message).toBe('done');
    const view = own.result as {
      exists: boolean;
      skills: Array<{ name: string }>;
      hooks: Array<{ event: string; command: string }>;
      rules: Array<{ path: string; paths?: string[] }>;
    };
    expect(view.exists).toBe(true);
    expect(view.skills.map((skill) => skill.name)).toEqual(['deploy']);
    expect(view.hooks).toHaveLength(1);
    expect(view.hooks[0]?.event).toBe('Stop');
    expect(view.rules.map((rule) => rule.path)).toEqual(['style.md']);
    expect(view.rules[0]?.paths).toEqual(['src/**']);
    expect(JSON.stringify(own)).not.toContain(SECRET);

    const copy = await h.call('read_project_local_config', { project: 'p-demo', copy: copyDir });
    expect(copy.outcome, copy.message).toBe('done');
    const copyRules = (copy.result as { rules: Array<{ path: string }> }).rules.map(
      (rule) => rule.path,
    );
    expect(copyRules).toEqual(expect.arrayContaining(['copy-only.md', 'style.md']));

    const foreign = await h.call('read_project_local_config', { project: outside });
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('not registered');
  });
});
