import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FormatCheckReport, FormatCheckResponse } from '@claude-control/contracts';
import { FormatCheckStore } from '../domains/format-check.ts';
import type { ServerContext } from '../context.ts';
import { registerFormatCheckRoutes } from './format-check-routes.ts';

/**
 * Сверка форматов глазами панели (IDEA-3): открытие раздела НЕ ждёт сеть, а
 * кнопка «проверить сейчас» ждёт и возвращает свежий отчёт. Настоящая сеть не
 * трогается: `fetch` подменён.
 */
const SCHEMA = {
  properties: {
    mcp: {},
    permission: {},
    plugin: {},
    experimental: { properties: { hook: {} } },
  },
};

describe('маршруты сверки форматов', () => {
  let root: string;
  let app: FastifyInstance;

  const get = async (): Promise<FormatCheckResponse> =>
    (await app.inject({ method: 'GET', url: '/api/format-check' })).json() as FormatCheckResponse;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-format-check-routes-'));
    const appData = join(root, 'claude-control');
    mkdirSync(appData, { recursive: true });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(SCHEMA), { status: 200 })),
    );

    const ctx = {
      location: { paths: { root, appData } },
      formatCheck: new FormatCheckStore(appData),
    } as unknown as ServerContext;

    app = Fastify();
    registerFormatCheckRoutes(app, ctx);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('первое открытие отдаёт пусто и не ждёт сеть', async () => {
    const body = await get();

    expect(body.report).toBeUndefined();
    expect(body.stale).toBe(true);
  });

  it('«проверить сейчас» возвращает отчёт, а следующее открытие берёт его из кэша', async () => {
    const refreshed = (
      await app.inject({ method: 'POST', url: '/api/format-check/refresh' })
    ).json() as FormatCheckReport;

    const opencode = refreshed.providers.find((row) => row.providerId === 'opencode');
    expect(opencode?.state).toBe('ok');
    expect(opencode?.keys.every((key) => key.present)).toBe(true);

    const calls = vi.mocked(globalThis.fetch).mock.calls.length;
    const body = await get();
    expect(body.stale).toBe(false);
    expect(body.report?.checkedAt).toBe(refreshed.checkedAt);
    // Кэш свежий — второй поход в сеть не случился.
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(calls);
  });

  it('нет сети — маршрут всё равно отвечает 200, а не 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('сети нет');
      }),
    );

    const response = await app.inject({ method: 'POST', url: '/api/format-check/refresh' });
    expect(response.statusCode).toBe(200);

    const report = response.json() as FormatCheckReport;
    expect(report.providers.find((row) => row.providerId === 'opencode')?.state).toBe(
      'unavailable',
    );
    // Провайдеры без опубликованной схемы отвечают то же самое и без сети.
    expect(report.providers.find((row) => row.providerId === 'codex')?.state).toBe('no-schema');
  });
});
