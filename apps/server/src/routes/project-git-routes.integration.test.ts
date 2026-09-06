import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectGitInfo, ProjectGitResult } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
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
    // Контекст этим маршрутам не нужен: путь приходит запросом.
    registerProjectGitRoutes(app, {} as ServerContext);
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

  it('несуществующий каталог отклоняется до запуска git — и на чтении, и на записи', async () => {
    const missing = join(dir, 'нет-такого-каталога');

    const read = await app.inject({ method: 'GET', url: `/api/project-git?path=${missing}` });
    expect(read.statusCode).toBe(400);
    expect(read.json<{ message: string }>().message).toContain('не существует');

    const write = await app.inject({
      method: 'POST',
      url: '/api/project-git/commit',
      payload: { path: missing, message: 'x' },
    });
    expect(write.statusCode).toBe(400);
  });

  it('файл вместо каталога отклоняется', async () => {
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    const res = await app.inject({ method: 'GET', url: `/api/project-git?path=${file}` });
    expect(res.statusCode).toBe(400);
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

  it.skipIf(!GIT_AVAILABLE)(
    'полный круг: ветка → коммит → переключение',
    async () => {
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
    },
    30_000,
  );

  it.skipIf(!GIT_AVAILABLE)(
    'pull без удалённых — 400 с текстом git, а не 500',
    async () => {
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

      // Ветка не из списка удалённого — отказ ещё до похода в сеть.
      const foreign = await app.inject({
        method: 'POST',
        url: '/api/project-git/pull',
        payload: { path: dir, branch: 'main' },
      });
      expect(foreign.statusCode).toBe(400);

      // Пустая строка от селекта «текущая ветка» — это обычный pull, а не
      // ветка с пустым именем: upstream не настроен, поэтому git откажет сам.
      const current = await app.inject({
        method: 'POST',
        url: '/api/project-git/pull',
        payload: { path: dir, branch: '' },
      });
      expect(current.statusCode).toBe(400);
      expect(current.json<{ message: string }>().message).not.toBe('');
    },
    30_000,
  );

  it('pull с нестроковой веткой — 400, а не попытка склеить путь', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-git/pull',
      payload: { path: dir, branch: 42 },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Параллельные рабочие копии по HTTP. Отдельный блок, потому что здесь важен
 * третий параметр маршрутов — реестр прогонов: копию, в которой работает агент,
 * не должен снести никто, включая телефон.
 */
describe('project-git-routes: рабочие копии', () => {
  let app: FastifyInstance;
  let dir: string;
  let siblings: string;
  /** Что «сейчас занято агентом» — подменяется в самом тесте. */
  let busyPath: string | undefined;
  /** Прогон в этой копии ещё идёт (иначе он лишь досиживает в буфере догона). */
  let busyRunning = true;

  const gitIn = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
  };

  beforeEach(async () => {
    // Длинная форма пути: git отвечает ею, а сравнение путей и есть защита.
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-wt-routes-')));
    siblings = join(dirname(dir), `${basename(dir)}-worktrees`);
    busyPath = undefined;
    busyRunning = true;
    app = Fastify();
    // Двойник реестра повторяет его существенное свойство: `active()` держит
    // прогон ещё минуту ПОСЛЕ завершения (буфер догона), и «занято» решает не
    // он, а `isRunning`.
    registerProjectGitRoutes(app, {} as ServerContext, {
      active: () => (busyPath ? [{ chatId: 'run-1', projectPath: busyPath }] : []),
      isRunning: () => busyRunning,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(siblings);
    dropTemp(dir);
  });

  it('каталог без git — 200 и isRepo:false, а не ошибка запроса', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/project-git/worktrees?path=${dir}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ isRepo: boolean }>().isRepo).toBe(false);
  });

  it('создание без имени ветки — 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-git/worktrees/add',
      payload: { path: dir },
    });
    expect(res.statusCode).toBe(400);
  });

  it('удаление без указания копии — 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-git/worktrees/remove',
      payload: { path: dir, worktreePath: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it.skipIf(!GIT_AVAILABLE)(
    'полный круг: завести копию, увидеть её в списке, убрать',
    async () => {
      gitIn(dir, 'init', '--initial-branch=main');
      gitIn(dir, 'config', 'user.email', 'test@example.invalid');
      gitIn(dir, 'config', 'user.name', 'Test');
      gitIn(dir, 'config', 'commit.gpgsign', 'false');
      writeFileSync(join(dir, 'file.txt'), 'первый\n');
      gitIn(dir, 'add', '-A');
      gitIn(dir, 'commit', '-m', 'первый');

      const added = await app.inject({
        method: 'POST',
        url: '/api/project-git/worktrees/add',
        payload: { path: dir, name: 'feature/x' },
      });
      expect(added.statusCode).toBe(200);
      const created = added.json<{ createdPath: string; info: { worktrees: unknown[] } }>();
      expect(created.info.worktrees).toHaveLength(2);
      expect(created.createdPath).toBe(join(siblings, 'feature-x'));

      // Пока в копии работает агент, снести её нельзя — и это 409, а не 400:
      // запрос верный, состояние мира против.
      busyPath = created.createdPath;
      const busy = await app.inject({
        method: 'POST',
        url: '/api/project-git/worktrees/remove',
        payload: { path: dir, worktreePath: created.createdPath },
      });
      expect(busy.statusCode).toBe(409);

      // А вот прогон, который ТОЛЬКО ЧТО закончился, копию не держит: реестр
      // помнит его ещё минуту, но останавливать уже некого — и удаление обязано
      // пройти. Раньше здесь была ровно та минута, когда кнопка «убрать» врала.
      busyRunning = false;
      const afterFinish = await app.inject({
        method: 'POST',
        url: '/api/project-git/worktrees/remove',
        payload: { path: dir, worktreePath: created.createdPath },
      });
      expect(afterFinish.statusCode).toBe(200);

      // Дальше копии уже нет — заводим её заново, чтобы проверить обычный путь.
      const again = await app.inject({
        method: 'POST',
        url: '/api/project-git/worktrees/add',
        payload: { path: dir, name: 'feature/x' },
      });
      expect(again.statusCode).toBe(200);

      busyPath = undefined;
      const removed = await app.inject({
        method: 'POST',
        url: '/api/project-git/worktrees/remove',
        payload: { path: dir, worktreePath: created.createdPath },
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json<{ info: { worktrees: unknown[] } }>().info.worktrees).toHaveLength(1);

      // Основная копия не удаляется ничем: это отказ домена, 400.
      const main = await app.inject({
        method: 'POST',
        url: '/api/project-git/worktrees/remove',
        payload: { path: dir, worktreePath: dir },
      });
      expect(main.statusCode).toBe(400);
    },
    60_000,
  );
  it('битое тело записи — 400 с именем поля, до git дело не доходит', async () => {
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/project-git/checkout',
      payload: { path: dir, branch: 42 },
    });
    expect(checkout.statusCode).toBe(400);
    expect(checkout.json()).toMatchObject({ code: 'invalid_body', issues: [{ path: 'branch' }] });

    const remove = await app.inject({
      method: 'POST',
      url: '/api/project-git/worktrees/remove',
      payload: { path: dir, worktreePath: '   ', force: 'yes' },
    });
    expect(remove.statusCode).toBe(400);
    const fields = (remove.json() as { issues: { path: string }[] }).issues.map((i) => i.path);
    expect(fields).toEqual(['worktreePath', 'force']);

    // Совсем без тела — тоже 400, а не 500 из `undefined.path`.
    const empty = await app.inject({ method: 'POST', url: '/api/project-git/push' });
    expect(empty.statusCode).toBe(400);
  });
});
