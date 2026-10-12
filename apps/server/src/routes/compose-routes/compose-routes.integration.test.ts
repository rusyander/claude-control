import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComposeInfo } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { DockerExec, DockerJobProcess } from '../../domains/compose/compose.ts';
import { registerComposeRoutes } from './compose-routes.ts';

/**
 * Маршруты Compose на уровне HTTP: проверка тела, граница «свой проект»,
 * подтверждение удаления томов, известный сервис, одно действие за раз.
 * Подменена только программа docker (внешний процесс); путь
 * «маршрут → поиск файла → разбор config → реестр» исполняется весь.
 * Настоящий docker гоняет `tools/qa/check-compose.mjs`.
 */

const CONFIG = JSON.stringify({
  name: 'shop',
  services: { db: { image: 'postgres' }, api: { build: {}, depends_on: ['db'] } },
  volumes: { pgdata: {} },
});

describe('compose: маршруты', () => {
  let app: FastifyInstance;
  let root: string;
  let project: string;
  let stranger: string;
  let spawned: { args: string[]; exit: (code: number) => void }[];

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-compose-routes-')));
    project = join(root, 'shop');
    stranger = join(root, 'other');
    for (const dir of [project, stranger]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'compose.yaml'), 'services: {}');
    }
    const store = new AppStore(join(root, 'agentdeck'));
    store.addProject({ id: 'shop', name: 'shop', path: project });

    const exec: DockerExec = async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: '29.7.2', stderr: '' };
      if (args[1] === 'config') return { code: 0, stdout: CONFIG, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    spawned = [];
    const spawn = (args: string[]): DockerJobProcess => {
      let onExit: (code: number | null, missing: boolean) => void = () => {};
      spawned.push({ args, exit: (code) => onExit(code, false) });
      return {
        onOutput: () => {},
        onExit: (listener) => {
          onExit = listener;
        },
        kill: () => {},
      };
    };
    app = Fastify();
    registerComposeRoutes(app, { store } as unknown as ServerContext, { exec, spawn });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const act = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/compose/action', payload: body });

  it('чтение: сервисы в порядке подъёма, тома, имя проекта', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/compose?path=${encodeURIComponent(project)}`,
    });
    const info = response.json<ComposeInfo>();
    expect(info).toMatchObject({ docker: 'ok', file: 'compose.yaml', projectName: 'shop' });
    expect(info.services.map((service) => `${service.name}:${service.state}`)).toEqual([
      'db:absent',
      'api:absent',
    ]);
    expect(info.volumes).toEqual(['pgdata']);
  });

  it('относительный путь — 400 со своим кодом', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/compose?path=shop' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'compose-path-required' });
  });

  it('чужой каталог — 403, docker не запускается', async () => {
    const response = await act({ path: stranger, action: 'up' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'compose-project-unregistered' });
    expect(spawned).toHaveLength(0);
  });

  it('удаление томов без подтверждения — 400; с ним — `down -v`', async () => {
    const refused = await act({ path: project, action: 'down-volumes' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'compose-confirm-required' });
    expect(spawned).toHaveLength(0);

    const accepted = await act({ path: project, action: 'down-volumes', confirm: true });
    expect(accepted.statusCode).toBe(200);
    expect(spawned[0]?.args.slice(-2)).toEqual(['down', '-v']);
    expect(accepted.json<ComposeInfo>().job).toMatchObject({
      action: 'down-volumes',
      status: 'running',
    });
  });

  it('сервиса нет в файле — 400; есть — команда сужена им', async () => {
    const unknown = await act({ path: project, action: 'up', service: 'redis' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: 'compose-service-unknown' });

    await act({ path: project, action: 'restart', service: 'db' });
    expect(spawned[0]?.args.slice(-2)).toEqual(['restart', 'db']);
  });

  it('второе действие поверх идущего — 409 с идущим; после конца — принято', async () => {
    await act({ path: project, action: 'up' });
    const busy = await act({ path: project, action: 'down' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ code: 'compose-busy', job: { action: 'up' } });

    spawned[0]?.exit(0);
    const next = await act({ path: project, action: 'down' });
    expect(next.statusCode).toBe(200);
    expect(spawned).toHaveLength(2);
  });

  it('неверное действие — 400 invalid_body', async () => {
    const response = await act({ path: project, action: 'nuke' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_body' });
  });

  it('файла нет — 404 со своим кодом', async () => {
    rmSync(join(project, 'compose.yaml'));
    const response = await act({ path: project, action: 'up' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'compose-file-missing' });
  });
});
