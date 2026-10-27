import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { registerIntegrationsRoutes } from '../integrations-routes/integrations-routes.ts';

/**
 * `GET /api/integrations/forge/mr-review` — живое MR для `tests-cli delivery` (F-14, аудит
 * g0 25.10). Ключ форджа — тот, что человек сохранил карточкой GitLab; сеть подменена на
 * уровне `fetch` ответами GitLab API v4, остальное — настоящий путь маршрута.
 */
const MR = 'https://git.acme.local/team/app/-/merge_requests/810';
const KEY = ['glpat', 'mr', 'review', '0001'].join('-');

describe('forge mr-review: MR для проверки доставки', () => {
  let app: FastifyInstance;
  let dir = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-forge-mr-'));
    const mcpConfig = join(dir, '.claude.json');
    writeFileSync(mcpConfig, '{}', 'utf8');
    app = Fastify();
    registerIntegrationsRoutes(
      app,
      {
        store: new AppStore(dir),
        backupDir: undefined,
        location: {
          paths: {
            appData: dir,
            mcpConfig,
            settings: join(dir, 'settings.json'),
            settingsLocal: join(dir, 'settings.local.json'),
            secretsEnv: join(dir, '.mcp-secrets.env'),
          },
        },
      } as unknown as ServerContext,
      'http://127.0.0.1:5178',
    );
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ask = async (url?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/integrations/forge/mr-review${url === undefined ? '' : `?url=${encodeURIComponent(url)}`}`,
    });

  const connect = async (): Promise<void> => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/integrations/gitlab',
      payload: {
        settings: { enabled: true, baseUrl: 'https://git.acme.local', repo: '' },
        token: KEY,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
  };

  it('без ключа форджа и без ссылки — причина кодом, наружу не ходит', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await ask(MR)).json()).toEqual({ review: null, reason: 'no-token' });
    expect((await ask()).json()).toEqual({ review: null, reason: 'not-mr' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('описание, автор, ветки ревьюера — да; конвейера и ключа в ответе нет', async () => {
    await connect();
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('private-token') });
      const body = /\/discussions\?/.test(String(url))
        ? [
            {
              id: 'd1',
              notes: [
                {
                  id: 7,
                  body: 'Rename this constant.',
                  author: { username: 'reviewer' },
                  system: false,
                  resolvable: true,
                  resolved: false,
                },
              ],
            },
          ]
        : {
            state: 'opened',
            author: { username: 'group' },
            description: 'Что и зачем.',
            head_pipeline: { id: 1, status: 'running', web_url: 'https://git.acme.local/p/1' },
          };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const response = await ask(MR);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(KEY);
    const { review } = response.json() as { review: Record<string, unknown> };
    expect(review).toMatchObject({ state: 'open', author: 'group', description: 'Что и зачем.' });
    expect(review).not.toHaveProperty('pipeline');
    expect(review.threads).toEqual([
      expect.objectContaining({
        id: 'd1',
        resolved: false,
        notes: [expect.objectContaining({ author: 'reviewer', body: 'Rename this constant.' })],
      }),
    ]);
    expect(calls[0]?.url).toBe(
      'https://git.acme.local/api/v4/projects/team%2Fapp/merge_requests/810',
    );
    expect(calls.every((call) => call.auth === KEY)).toBe(true);
  });

  it('фордж не ответил — 502 и причина кодом', async () => {
    await connect();
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const response = await ask(MR);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ review: null, reason: 'unreachable' });
  });
});
