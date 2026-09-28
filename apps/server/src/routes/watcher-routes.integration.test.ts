import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatcherStatus } from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { BackgroundWatcher } from '../domains/watcher/watcher.ts';
import { sectionsOf } from '../domains/watcher/report.ts';
import { registerWatcherRoutes } from './watcher-routes.ts';

/** Маршруты наблюдателя поверх настоящего наблюдателя; CLI нет — разбор не запускается. */
describe('маршруты фонового наблюдателя', () => {
  let dir: string;
  let app: FastifyInstance;
  let watcher: BackgroundWatcher;
  const report = (): string => join(dir, 'WATCH-REPORT.md');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watch-routes-'));
    watcher = new BackgroundWatcher({
      appDataDir: () => dir,
      reportPath: report,
      cwd: dir,
      resolveCommand: () => undefined,
      model: () => undefined,
      pricing: () => ({}),
      debounceMs: 10_000,
    });
    app = Fastify();
    registerWatcherRoutes(app, {} as ServerContext, watcher);
    await app.ready();
  });
  afterEach(async () => {
    watcher.shutdown();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('тумблер: битое тело — 400 с именем поля, верное — новый статус', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/watcher',
      payload: { enabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('enabled');

    const on = await app.inject({
      method: 'POST',
      url: '/api/watcher',
      payload: { enabled: true },
    });
    const status = on.json<WatcherStatus>();
    expect(status.enabled).toBe(true);
    expect(status.since).toBeTruthy();
    expect(status.reportPath).toBe(report());
    expect(status.problem?.problemCode).toBe('cli_missing');
  });

  it('сбой со страницы: выключен — не принят, включён — раздел в отчёте', async () => {
    const signal = { kind: 'window-error', message: 'x is not a function', route: '/settings' };
    const off = await app.inject({ method: 'POST', url: '/api/watcher/events', payload: signal });
    expect(off.json()).toEqual({ accepted: false });
    expect(existsSync(report())).toBe(false);

    await app.inject({ method: 'POST', url: '/api/watcher', payload: { enabled: true } });
    const on = await app.inject({ method: 'POST', url: '/api/watcher/events', payload: signal });
    expect(on.json()).toEqual({ accepted: true });
    const text = readFileSync(report(), 'utf8');
    expect(sectionsOf(text).size).toBe(1);
    expect(text).toContain('`/settings`');
  });

  it('чужой вид сигнала со страницы (серверный) — 400, не запись', async () => {
    await app.inject({ method: 'POST', url: '/api/watcher', payload: { enabled: true } });
    const forged = await app.inject({
      method: 'POST',
      url: '/api/watcher/events',
      payload: { kind: 'http-5xx', message: 'forged' },
    });
    expect(forged.statusCode).toBe(400);
    expect(existsSync(report())).toBe(false);
  });
});
