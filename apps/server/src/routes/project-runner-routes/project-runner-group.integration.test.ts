import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectRunnerInfo, ProjectRunnerView } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ProjectRunnerRegistry } from '../../domains/project-runner/project-runner.ts';
import { registerProjectRunnerRoutes } from './project-runner-routes.ts';

/**
 * «Запустить всё» / «Остановить всё» и отметка цели — на уровне HTTP, с
 * НАСТОЯЩИМИ процессами: каждая цель запускает node-сервер, который печатает
 * адрес так, как печатают бэкенды (`listening on :PORT`), без схемы. Подменена
 * только команда запуска — путь «маршрут → реестр → spawn → разбор вывода»
 * исполняется весь.
 */

const SERVER = `
const http = require('node:http');
const server = http.createServer((req, res) => res.end('ok'));
server.listen(0, '127.0.0.1', () => console.log('svc listening on :' + server.address().port));
`;

describe('project-runner: набор «Запустить всё»', () => {
  let app: FastifyInstance;
  let root: string;
  let project: string;
  let registry: ProjectRunnerRegistry;

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-runner-group-')));
    project = join(root, 'shop');
    for (const dir of ['', 'apps/api', 'apps/worker']) {
      mkdirSync(join(project, dir), { recursive: true });
      writeFileSync(
        join(project, dir, 'package.json'),
        JSON.stringify({ name: dir || 'shop', scripts: { dev: 'x' } }),
      );
      writeFileSync(join(project, dir, 'server.cjs'), SERVER);
    }
    writeFileSync(join(project, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");

    const store = new AppStore(join(root, 'agentdeck'));
    store.addProject({ id: 'shop', name: 'shop', path: project });
    registry = new ProjectRunnerRegistry({
      openBrowser: () => {},
      resolveLaunch: (target) => ({
        file: process.execPath,
        args: [join(target, 'server.cjs')],
        display: 'node svc',
      }),
      readyTimeoutMs: 15_000,
    });
    app = Fastify();
    registerProjectRunnerRoutes(app, { store } as unknown as ServerContext, registry);
    await app.ready();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // temp уйдёт с ОС
    }
  });

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/project-runner/${url}`, payload: payload as object });

  it('отметка живёт на цель и снимается', async () => {
    await post('group', { path: project, dir: 'apps/api', inGroup: true });
    const res = await post('group', { path: project, dir: 'apps/worker', inGroup: true });
    expect(res.statusCode).toBe(200);
    const marks = res
      .json<ProjectRunnerInfo>()
      .targets.map((target) => [target.dir, target.inGroup]);
    expect(marks).toEqual([
      ['', false],
      ['apps/api', true],
      ['apps/worker', true],
    ]);
    const off = await post('group', { path: project, dir: 'apps/api', inGroup: false });
    expect(off.json<ProjectRunnerInfo>().targets[1]?.inGroup).toBe(false);
  });

  it('негатив: цель вне проекта и тело без отметки — 400 с понятной причиной', async () => {
    const outside = await post('group', { path: project, dir: '../other', inGroup: true });
    expect(outside.statusCode).toBe(400);
    expect(outside.json<{ messageCode: string }>().messageCode).toBe('runner-subdir-outside');
    const noFlag = await post('group', { path: project, dir: 'apps/api' });
    expect(noFlag.statusCode).toBe(400);
    expect(noFlag.json<{ code: string }>().code).toBe('invalid_body');
  });

  it('«Запустить всё» поднимает только отмеченные, «Остановить всё» гасит их', async () => {
    await post('group', { path: project, dir: 'apps/api', inGroup: true });
    await post('group', { path: project, dir: 'apps/worker', inGroup: true });

    const all = await post('start-all', { path: project });
    expect(all.statusCode).toBe(200);
    const body = all.json<{ started: ProjectRunnerView[]; failed: unknown[] }>();
    expect(body.started.map((run) => run.dir).sort()).toEqual(['apps/api', 'apps/worker']);
    expect(body.failed).toEqual([]);

    // Адрес без схемы читается из вывода — обе цели становятся «работает» с портом.
    let runs: ProjectRunnerView[] = [];
    for (let i = 0; i < 100; i += 1) {
      runs = registry.list();
      if (runs.length === 2 && runs.every((run) => run.status === 'running')) break;
      await new Promise((sleep) => setTimeout(sleep, 100));
    }
    expect(runs.map((run) => [run.dir, run.status, typeof run.port])).toEqual(
      expect.arrayContaining([
        ['apps/api', 'running', 'number'],
        ['apps/worker', 'running', 'number'],
      ]),
    );

    const stop = await post('stop-all', { path: project });
    expect(stop.json<{ stopped: number }>().stopped).toBe(2);
    expect(registry.list()).toEqual([]);
  });

  it('«Запустить всё» у каталога вне проектов панели — 403', async () => {
    const stranger = join(root, 'stranger');
    mkdirSync(stranger);
    const res = await post('start-all', { path: stranger });
    expect(res.statusCode).toBe(403);
  });
});
