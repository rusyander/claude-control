import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import type { ProjectRunnerInfo } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { ProjectRunnerRegistry } from '../domains/project-runner.ts';
import { registerProjectRunnerRoutes } from './project-runner-routes.ts';

/**
 * Маршруты запуска dev-серверов на уровне HTTP.
 *
 * Ничего не запускаем: старт спавнит настоящий процесс, и это дело тестов
 * домена. Здесь проверяется контур вокруг — адресация цели (`path` + `dir`),
 * отказ на подпапке вне проекта, и то, что настройки живут на цель, а не на
 * проект. Реестр берётся настоящий: он не запускается, пока его не попросят.
 */

/** Снос временного каталога: на Windows хендлы отпускаются не сразу. */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

function writePkg(dir: string, pkg: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
}

describe('project-runner-routes', () => {
  let app: FastifyInstance;
  let store: AppStore;
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-runner-routes-'));

    // Монорепа: корень со скриптом и два пакета.
    project = join(root, 'mono');
    writePkg(project, { name: 'mono', scripts: { dev: 'vite' } });
    writeFileSync(join(project, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    writePkg(join(project, 'apps', 'web'), { name: 'web', scripts: { dev: 'vite' } });
    writePkg(join(project, 'apps', 'api'), { name: 'api', scripts: { start: 'node .' } });

    store = new AppStore(join(root, 'claude-control'));
    app = Fastify();
    registerProjectRunnerRoutes(
      app,
      { store } as unknown as ServerContext,
      new ProjectRunnerRegistry({ openBrowser: () => {} }),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(root);
  });

  /** Описание целей проекта — им отвечает большинство маршрутов. */
  const describeTargets = async (): Promise<ProjectRunnerInfo> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/project-runner/describe?path=${encodeURIComponent(project)}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json<ProjectRunnerInfo>();
  };

  it('describe отдаёт корень и пакеты монорепы с командами', async () => {
    const info = await describeTargets();
    expect(info.workspaceSource).toBe('pnpm');
    expect(info.targets.map((target) => target.dir).sort()).toEqual(['', 'apps/api', 'apps/web']);
    expect(info.targets.every((target) => target.runnable)).toBe(true);
    expect(info.targets.find((target) => target.dir === 'apps/web')?.command).toBe('pnpm run dev');
  });

  it('без пути или с относительным путём — 400', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/project-runner/describe' })).statusCode,
    ).toBe(400);
    const relative = await app.inject({
      method: 'POST',
      url: '/api/project-runner/start',
      payload: { path: './x' },
    });
    expect(relative.statusCode).toBe(400);
  });

  it('подпапка вне проекта — 400, а не запуск чего попало', async () => {
    for (const dir of ['../elsewhere', '/etc', 'apps/../../root']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/project-runner/settings',
        payload: { path: project, dir, command: 'node .' },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('настройки живут на цель: команда и порт не протекают на соседнюю', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/project-runner/settings',
      payload: { path: project, dir: 'apps/web', command: 'pnpm dev:web', port: 5173 },
    });

    const info = await describeTargets();
    const web = info.targets.find((target) => target.dir === 'apps/web');
    const api = info.targets.find((target) => target.dir === 'apps/api');

    expect(web?.commandOverride).toBe('pnpm dev:web');
    expect(web?.command).toBe('pnpm dev:web');
    expect(web?.pinnedPort).toBe(5173);
    expect(api?.commandOverride).toBeUndefined();
    expect(api?.pinnedPort).toBeUndefined();
  });

  it('пустая команда и null-порт снимают настройку', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/project-runner/settings',
      payload: { path: project, dir: 'apps/web', command: 'pnpm dev:web', port: 5173 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/project-runner/settings',
      payload: { path: project, dir: 'apps/web', command: '', port: null },
    });

    const web = (await describeTargets()).targets.find((target) => target.dir === 'apps/web');
    expect(web?.commandOverride).toBeUndefined();
    expect(web?.pinnedPort).toBeUndefined();
    // Скрипт из package.json никуда не делся — цель снова запускаема им.
    expect(web?.command).toBe('pnpm run dev');
  });

  it('автозапуск ставится на цель и виден в ответе', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-runner/autostart',
      payload: { path: project, dir: 'apps/api', enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json<ProjectRunnerInfo>().targets.find((target) => target.dir === 'apps/api')?.autostart,
    ).toBe(true);

    expect(store.listAutostartProjects().map((prefs) => prefs.dir)).toEqual(['apps/api']);
  });

  it('нечисловой enabled — 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-runner/autostart',
      payload: { path: project, enabled: 'да' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('clear снимает автозапуск со всех целей проекта разом', async () => {
    for (const dir of ['', 'apps/web', 'apps/api']) {
      await app.inject({
        method: 'POST',
        url: '/api/project-runner/autostart',
        payload: { path: project, dir, enabled: true },
      });
    }
    expect(store.listAutostartProjects()).toHaveLength(3);

    const res = await app.inject({
      method: 'POST',
      url: '/api/project-runner/autostart/clear',
      payload: { path: project },
    });
    expect(res.statusCode).toBe(200);
    expect(store.listAutostartProjects()).toEqual([]);
    expect(res.json<ProjectRunnerInfo>().targets.every((target) => !target.autostart)).toBe(true);
  });

  it('стоп незапущенной цели — 200 с ok:false, а не ошибка', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-runner/stop',
      payload: { path: project, dir: 'apps/web' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(false);
  });

  it('кто занял порт: свободный порт — пусто, и освобождать некого', async () => {
    // Занимаем и сразу отпускаем — номер точно ничей.
    const probe = createServer();
    const port = await new Promise<number>((ready) => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        ready(typeof address === 'object' && address ? address.port : 0);
      });
    });
    await new Promise((done) => probe.close(() => done(undefined)));

    const res = await app.inject({ method: 'GET', url: `/api/project-runner/port?port=${port}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ busy: boolean }>().busy).toBe(false);

    const freed = await app.inject({
      method: 'POST',
      url: '/api/project-runner/free-port',
      payload: { port },
    });
    expect(freed.statusCode).toBe(200);
    expect(freed.json<{ busy: boolean; killed: number[] }>()).toMatchObject({
      busy: false,
      killed: [],
    });
  });

  it('порт вне диапазона — 400, а не попытка кого-то убить', async () => {
    for (const port of [0, -1, 70_000, undefined]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/project-runner/free-port',
        payload: { port },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('нет ни скрипта, ни команды → цель не запускаема, но остаётся в списке', async () => {
    const bare = join(root, 'bare');
    writePkg(bare, { name: 'bare', scripts: { build: 'tsc' } });

    const res = await app.inject({
      method: 'GET',
      url: `/api/project-runner/describe?path=${encodeURIComponent(bare)}`,
    });
    const info = res.json<ProjectRunnerInfo>();
    expect(info.targets).toHaveLength(1);
    expect(info.targets[0]?.runnable).toBe(false);
    expect(info.targets[0]?.reason).toContain('dev');

    // Команда вручную делает её запускаемой — ради этого корень и остаётся в списке.
    await app.inject({
      method: 'POST',
      url: '/api/project-runner/settings',
      payload: { path: bare, command: 'node server.mjs' },
    });
    const after = await app.inject({
      method: 'GET',
      url: `/api/project-runner/describe?path=${encodeURIComponent(bare)}`,
    });
    expect(after.json<ProjectRunnerInfo>().targets[0]?.runnable).toBe(true);
  });
});
