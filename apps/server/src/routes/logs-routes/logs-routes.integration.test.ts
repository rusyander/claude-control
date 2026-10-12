import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogsChunk, LogsSources } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { DockerExec } from '../../domains/compose/compose.ts';
import { ProjectRunnerRegistry } from '../../domains/project-runner/registry.ts';
import type { LaunchSpec } from '../../domains/project-runner/project-runner.types.ts';
import { registerLogsRoutes } from './logs-routes.ts';

/**
 * Маршруты «Логов» по HTTP с НАСТОЯЩИМ реестром запусков: процесс node пишет
 * в stdout и stderr, панель отдаёт строки, курсор — только новое, после «Стоп»
 * вывод остаётся, перезапуск сбрасывает курсор. Docker подменён: он — внешняя
 * программа, настоящий проверяется живьём в `tools/qa/check-logs.mjs`.
 */

const CHATTY = `
console.log('{"level":"info","msg":"listening"}');
console.error('\\x1b[31mERROR\\x1b[0m cannot reach db');
let n = 0;
setInterval(() => console.log('tick ' + ++n), 150);
`;

async function until<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await new Promise((sleep) => setTimeout(sleep, 100));
  }
}

describe('logs: маршруты', { timeout: 30_000 }, () => {
  let app: FastifyInstance;
  let root: string;
  let project: string;
  let stranger: string;
  let registry: ProjectRunnerRegistry;

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-logs-routes-')));
    project = join(root, 'shop');
    stranger = join(root, 'other');
    const appData = join(root, 'agentdeck');
    for (const dir of [join(project, 'cmd', 'api'), stranger, appData]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(project, 'chatty.cjs'), CHATTY);
    const store = new AppStore(appData);
    store.addProject({ id: 'shop', name: 'shop', path: project });
    const launch = (): LaunchSpec => ({
      file: process.execPath,
      args: [join(project, 'chatty.cjs')],
      display: 'node chatty.cjs',
      browser: false,
    });
    registry = new ProjectRunnerRegistry({
      openBrowser: () => {},
      resolveLaunch: launch,
      readyTimeoutMs: 60_000,
    });
    const exec: DockerExec = async () => ({ code: 0, stdout: '', stderr: '' });
    app = Fastify();
    registerLogsRoutes(app, { store } as unknown as ServerContext, {
      runs: (path) => registry.logsOf(path),
      exec,
    });
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

  const sources = async (path = project) =>
    app.inject({ method: 'GET', url: `/api/logs/sources?path=${encodeURIComponent(path)}` });
  const read = async (cursor?: string): Promise<LogsChunk> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/logs?path=${encodeURIComponent(project)}&source=${encodeURIComponent(
          'run:cmd/api',
        )}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      })
    ).json<LogsChunk>();

  it('без пути — 400, чужой каталог — 403, без source — 400, неизвестный — 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/logs/sources' })).json()).toMatchObject({
      code: 'logs-path-required',
    });
    const foreign = await sources(stranger);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'logs-project-unregistered' });
    const noSource = await app.inject({
      method: 'GET',
      url: `/api/logs?path=${encodeURIComponent(project)}`,
    });
    expect(noSource.json()).toMatchObject({ code: 'logs-source-required' });
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/logs?path=${encodeURIComponent(project)}&source=run%3Aghost`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'logs-source-unknown' });
  });

  it('настоящий процесс: оба потока, курсор, вывод после «Стоп», сброс при перезапуске', async () => {
    await registry.start({ projectPath: project, dir: 'cmd/api' });
    const listed = (await sources()).json<LogsSources>();
    expect(listed.sources.map((source) => [source.id, source.detail])).toEqual([
      ['run:cmd/api', 'node chatty.cjs'],
    ]);
    expect(listed.docker).toBe('none');

    const first = await until(read, (chunk) =>
      chunk.lines.some((line) => line.text.startsWith('tick')),
    );
    const texts = first.lines.map((line) => line.text);
    expect(texts).toContain('{"level":"info","msg":"listening"}');
    expect(first.lines.find((line) => line.text.includes('cannot reach'))).toMatchObject({
      stream: 'stderr',
      text: 'ERROR cannot reach db',
    });

    const next = await until(
      () => read(first.cursor),
      (chunk) => chunk.lines.length > 0,
    );
    expect(next.lines.every((line) => line.text.startsWith('tick'))).toBe(true);
    expect(next.lines.map((line) => line.text)).not.toContain(texts.at(-1));

    registry.stop({ projectPath: project, dir: 'cmd/api' });
    const stopped = await read(next.cursor);
    expect(stopped.idle).toBe(true);
    const after = (await sources()).json<LogsSources>();
    expect(after.sources[0]).toMatchObject({ id: 'run:cmd/api', state: 'stopped' });
    expect((await read()).lines.length).toBeGreaterThan(2);

    await new Promise((sleep) => setTimeout(sleep, 5));
    await registry.start({ projectPath: project, dir: 'cmd/api' });
    const fresh = await until(
      () => read(stopped.cursor),
      (chunk) => chunk.lines.length > 0,
    );
    expect(fresh.reset).toBe(true);
    expect(fresh.lines[0]?.text).toBe('{"level":"info","msg":"listening"}');
  });
});
