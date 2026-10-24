import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorktreeMirrorSettings } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import { WorktreeBootstraps } from '../../domains/project-git/bootstrap.ts';
import { PREP_TREE_HOOKS } from '../../domains/project-git/lockfiles.ts';
import { registerProjectGitRoutes } from './project-git-routes.ts';

/**
 * L5 (ревью 23.10): маршрут повтора установки делал снимок дерева ДО запуска,
 * асинхронно, — между проверкой «уже идёт» и запуском. Второй запрос в этот
 * промежуток проходил проверку, получал 200 и снимал дерево поверх идущей
 * установки. Теперь снимок — внутри запуска реестра, а запуск синхронный:
 * второй запрос видит занятую копию и получает 409.
 *
 * Реестр — настоящий, с той же обвязкой, что у сервера (`PREP_TREE_HOOKS`);
 * git и команда установки — настоящие.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

const gitIn = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
};

describe('POST /api/project-git/worktrees/bootstrap: два запроса разом', () => {
  let app: FastifyInstance;
  let dir: string;
  let siblings: string;
  let temps: string[];
  let registry: WorktreeBootstraps;
  const mirrors = new Map<string, WorktreeMirrorSettings>();

  const temp = (prefix: string): string => {
    const made = mkdtempSync(join(tmpdir(), prefix));
    temps.push(made);
    return made;
  };

  beforeEach(async () => {
    temps = [];
    mirrors.clear();
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-boot-race-')));
    siblings = join(dirname(dir), `${basename(dir)}-worktrees`);
    registry = new WorktreeBootstraps(temp('cc-boot-race-logs-'), PREP_TREE_HOOKS);
    const ctx = {
      worktreeBootstraps: registry,
      location: { paths: { mcpConfig: join(temp('cc-boot-race-home-'), '.claude.json') } },
      store: {
        getSettings: () => ({ deliverToMr: false }),
        getSplitSettings: () => undefined,
        setSplitSettings: () => undefined,
        getWorktreeMirror: (path: string) => mirrors.get(path) ?? { include: [], exclude: [] },
        setWorktreeMirror: (path: string, settings: WorktreeMirrorSettings) => {
          mirrors.set(path, settings);
          return settings;
        },
      },
    } as unknown as ServerContext;
    app = Fastify();
    registerProjectGitRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(siblings);
    dropTemp(dir);
    for (const made of temps) dropTemp(made);
  });

  it('второй, пока первый идёт, — 409; lock-файл, переписанный установкой, откачен', async () => {
    gitIn(dir, 'init', '--initial-branch=main');
    gitIn(dir, 'config', 'user.email', 'test@example.invalid');
    gitIn(dir, 'config', 'user.name', 'Test');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'first');
    const copy = join(siblings, 'feature-one');
    gitIn(dir, 'worktree', 'add', '-b', 'feature/one', copy);

    // Установка: переписывает lock-файл и держит копию занятой полсекунды.
    const script = join(temp('cc-boot-race-cmd-'), 'install.cjs').replace(/\\/g, '/');
    writeFileSync(
      script,
      "require('fs').writeFileSync('pnpm-lock.yaml', 'lockfileVersion: 10\\n');\nsetTimeout(() => {}, 500);\n",
    );
    mirrors.set(dir, { include: [], exclude: [], bootstrap: `node "${script}"` });

    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/project-git/worktrees/bootstrap',
        payload: { path: dir, worktreePath: copy },
      });
    const codes = (await Promise.all([post(), post()])).map((res) => res.statusCode).sort();
    expect(codes).toEqual([200, 409]);

    // Дождаться конца установки: снимок был до команды — её правка откачена.
    const deadline = Date.now() + 15_000;
    while (registry.isRunning(copy) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(registry.status(copy)?.status).toBe('ok');
    expect(readFileSync(join(copy, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9\n');
  });
});
