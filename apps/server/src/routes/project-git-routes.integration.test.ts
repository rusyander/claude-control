import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectGitInfo, ProjectGitResult } from '@claude-control/contracts';
import { registerProjectGitRoutes } from './project-git-routes.ts';

/**
 * Маршруты git проекта. Главное, что проверяем на уровне HTTP: чтение всегда
 * 200 (даже «не репозиторий» — это ответ, а не ошибка), а любая неудавшаяся
 * запись — 400 с человеческим текстом, а не 500.
 */
/**
 * Снос временного каталога. На Windows git и запущенные процессы держат хендлы
 * дольше, чем живёт тест, поэтому неудача уборки — не провал проверки: каталог
 * лежит в temp и уйдёт с ОС.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

describe('project-git-routes', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-git-routes-'));
    app = Fastify();
    registerProjectGitRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(dir);
  });

  it('без пути или с относительным путём — 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/project-git' })).statusCode).toBe(400);
    const relative = await app.inject({ method: 'GET', url: '/api/project-git?path=./x' });
    expect(relative.statusCode).toBe(400);
  });

  it('каталог без .git — 200 и isRepo:false', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/project-git?path=${dir}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProjectGitInfo>().isRepo).toBe(false);
  });

  it('запись в каталог без .git — 400 с текстом, а не 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-git/commit',
      payload: { path: dir, message: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('.git');
  });

  it('пустое тело операции — 400 (ветка/сообщение обязательны)', async () => {
    const branch = await app.inject({
      method: 'POST',
      url: '/api/project-git/checkout',
      payload: { path: dir },
    });
    expect(branch.statusCode).toBe(400);

    const commit = await app.inject({
      method: 'POST',
      url: '/api/project-git/commit',
      payload: { path: dir },
    });
    expect(commit.statusCode).toBe(400);
  });

  it.skipIf(!GIT_AVAILABLE)('полный круг: ветка → коммит → переключение', async () => {
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
    };
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-m', 'first');

    const created = await app.inject({
      method: 'POST',
      url: '/api/project-git/branch',
      payload: { path: dir, name: 'feature/x' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json<ProjectGitResult>().info.branch).toBe('feature/x');

    writeFileSync(join(dir, 'b.txt'), 'b\n');
    const committed = await app.inject({
      method: 'POST',
      url: '/api/project-git/commit',
      payload: { path: dir, message: 'через панель' },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json<ProjectGitResult>().info.dirtyCount).toBe(0);

    const switched = await app.inject({
      method: 'POST',
      url: '/api/project-git/checkout',
      payload: { path: dir, branch: 'main' },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json<ProjectGitResult>().info.branch).toBe('main');

    // Ветки нет среди локальных — 400, а не молчаливый detached HEAD.
    const missing = await app.inject({
      method: 'POST',
      url: '/api/project-git/checkout',
      payload: { path: dir, branch: 'origin/main' },
    });
    expect(missing.statusCode).toBe(400);
  }, 30_000);
});
