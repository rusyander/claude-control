import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { registerEmptyBodyGuard } from '../lib/empty-body.ts';
import type { ServerContext } from '../context.ts';
import { registerGroupRoutes } from './group-routes.ts';
import { registerProjectGitRoutes } from './project-git-routes.ts';
import { registerHookRoutes } from './entity/hook-routes.ts';
import { registerMcpRoutes } from './entity/mcp-routes.ts';
import { registerScriptRoutes } from './script-routes.ts';
import { registerPluginRoutes } from './plugin-routes.ts';

/**
 * Запрос без тела не должен ронять сервер.
 *
 * Fastify отдаёт обработчику `undefined`, если тела нет и заголовка типа тоже
 * нет (а на литерал `null` — сам `null`). Маршрут, читающий `request.body.поле`
 * напрямую, отвечает на такой запрос пятисоткой: снаружи это выглядит как
 * сломанная панель, хотя сломан ровно один запрос. Через Tailscale к серверу
 * ходит ещё и телефон, так что обрезанное тело — не выдумка.
 *
 * Проверяем не «какой именно ответ», а границу: что угодно, кроме 500. Каким
 * будет 200 или 400, решает сам маршрут, и его смысл проверяют другие тесты.
 */
describe('маршруты: запрос без тела не даёт 500', () => {
  let root: string;
  let app: FastifyInstance;
  let groupId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-empty-body-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          appData: join(root, 'claude-control'),
        },
      },
      store: new AppStore(join(root, 'claude-control')),
      backupDir: join(root, 'claude-control', 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    // Тот же самый хук, что стоит в боевом `index.ts`: без него стенд проверял
    // бы не тот сервер, который работает у человека.
    registerEmptyBodyGuard(app);
    registerGroupRoutes(app, ctx);
    // Реестр прогонов не передаём: он необязателен, а проверяем мы разбор тела.
    registerProjectGitRoutes(app, ctx);
    registerHookRoutes(app, ctx);
    registerMcpRoutes(app, ctx);
    registerScriptRoutes(app, ctx);
    registerPluginRoutes(app, ctx);
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'Набор' },
    });
    groupId = created.json<{ id: string }>().id;
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Тело не передаём вовсе — ни строки, ни заголовка типа. */
  const bodyless = (method: 'POST' | 'PUT', url: string) => app.inject({ method, url });

  const routes: ['POST' | 'PUT', string][] = [
    ['POST', '/api/groups'],
    ['PUT', `/api/groups/${'ЗАГЛУШКА'}`],
    ['POST', '/api/groups/ЗАГЛУШКА/enabled'],
    ['POST', '/api/groups/activate'],
    ['POST', '/api/automations'],
    ['PUT', '/api/automations/ЗАГЛУШКА'],
    ['POST', '/api/project-git/checkout'],
    ['POST', '/api/project-git/branch'],
    ['POST', '/api/project-git/commit'],
    ['POST', '/api/project-git/pull'],
    ['POST', '/api/project-git/push'],
    ['POST', '/api/project-git/worktrees/add'],
    ['POST', '/api/project-git/worktrees/remove'],
    // Правки настоящего ~/.claude: хуки, MCP-серверы, скрипты.
    ['POST', '/api/hooks'],
    ['PUT', '/api/hooks/Stop:0:0'],
    ['POST', '/api/hooks/Stop:0:0/move'],
    ['POST', '/api/mcp'],
    ['PUT', '/api/mcp/нет-такого'],
    ['POST', '/api/scripts'],
    ['PUT', '/api/scripts/probe.mjs'],
    // Плагины: каждая операция запускает CLI, который ходит в сеть, поэтому
    // отказ обязан случиться ДО запуска.
    ['POST', '/api/plugins/install'],
    ['POST', '/api/plugins/marketplaces'],
    ['POST', '/api/plugins/нет-такого/enabled'],
    ['POST', '/api/plugins/scaffold'],
  ];

  for (const [method, url] of routes) {
    it(`${method} ${url}`, async () => {
      const target = url.replace('ЗАГЛУШКА', groupId);
      const res = await bodyless(method, target);
      expect(res.statusCode).toBeLessThan(500);
    });
  }

  it('переключатель группы без состояния отвечает 400, а не гасит наугад', async () => {
    // Домыслить `isEnabled` нельзя: промах здесь означал бы правку настоящего
    // ~/.claude не в ту сторону.
    const res = await app.inject({ method: 'POST', url: `/api/groups/${groupId}/enabled` });
    expect(res.statusCode).toBe(400);
  });

  it('набор без имени не заводится: безымянную строку в списке не опознать', async () => {
    // PUT по неизвестному id тоже ЗАВОДИТ набор, поэтому проверяются оба входа.
    for (const [method, url] of [
      ['POST', '/api/groups'],
      ['PUT', '/api/groups/нет-такого'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(400);
    }

    const list = await app.inject({ method: 'GET', url: '/api/groups' });
    expect(list.json<{ name: string }[]>().every((group) => group.name.trim() !== '')).toBe(true);
  });

  it('пустой сценарий не заводится: он компилируется в хук настоящего конфига', async () => {
    for (const [method, url] of [
      ['POST', '/api/automations'],
      ['PUT', '/api/automations/нет-такого'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(400);
    }

    const list = await app.inject({ method: 'GET', url: '/api/automations' });
    expect(list.json()).toEqual([]);
  });

  it('прочие переключатели без состояния тоже отказывают, а не выбирают за человека', async () => {
    // Раньше пустое тело здесь означало «вниз» и «выключить»: оборванный запрос
    // молча переставлял хук и гасил плагин.
    for (const url of ['/api/hooks/Stop:0:0/move', '/api/plugins/нет-такого/enabled']) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it('литерал null в теле обрабатывается как отсутствие тела', async () => {
    // `typeof null === "object"`, поэтому проверка «есть ли тело» через typeof
    // такой запрос пропустила бы, а чтение поля всё равно упало бы.
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/activate',
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });
    expect(res.statusCode).toBeLessThan(500);
  });
});

/**
 * Тот же дефект жил ещё в четырнадцати файлах маршрутов — `sandbox`, `resource`,
 * `project-runner`, `script`, `plugin`, `backup`, `config`, `entity/{hook,mcp}`,
 * `chat/browse`, `project-tests`, `assistant`, `provider-chat`, `project-git`:
 * сорок семь мест, читающих `request.body.поле` напрямую. Править их по одному
 * значило бы завести сорок семь возможностей забыть — и ещё одну в каждом новом
 * маршруте. Поэтому чинит хук, а проверяется здесь ОН, на обработчике, который
 * читает поле ровно так же беспечно.
 */
describe('хук пустого тела', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    registerEmptyBodyGuard(app);

    // Нарочно беспечный обработчик: именно такой код и живёт в тех маршрутах —
    // поле читается напрямую, без `?.` и без запасного пустого объекта.
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      app[method]<{ Body: { name?: string } }>('/probe', (request) => ({
        name: request.body.name ?? null,
      }));
    }
    app.get('/probe-get', (request) => ({ body: request.body ?? null }));

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    it(`${method} без тела не падает`, async () => {
      const res = await app.inject({ method, url: '/probe' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: null });
    });
  }

  it('литерал null тоже становится пустым объектом', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });

    expect(res.statusCode).toBe(200);
  });

  it('настоящее тело хук не трогает', async () => {
    const res = await app.inject({ method: 'POST', url: '/probe', payload: { name: 'Набор' } });

    expect(res.json()).toEqual({ name: 'Набор' });
  });

  it('у GET тела не появляется: врать о запросе нельзя', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe-get' });

    expect(res.json()).toEqual({ body: null });
  });
});
