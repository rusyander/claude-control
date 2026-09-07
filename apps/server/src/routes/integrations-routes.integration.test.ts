import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../context.ts';
import { AppStore } from '../lib/app-store.ts';
import { registerIntegrationsRoutes } from './integrations-routes.ts';

/**
 * Поверхность интеграций через HTTP — ровно та, что описана в контракте и
 * которую разбирает интерфейс.
 *
 * Сеть подменена. Главное, что проверяется здесь: PUT принимает токен, а ни
 * один ответ его не возвращает; неизвестная интеграция даёт 404, а не 500; и
 * неподключённая система отвечает 404 «не подключена», а не молчаливым пустым
 * списком.
 */
describe('integrations-routes: поверхность', () => {
  let app: FastifyInstance;
  let dir = '';
  let mcpConfig = '';

  const SECRET = 'ATLASSIAN-TOKEN-СЕКРЕТ-42';

  const post = async (url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, payload });
  const put = async (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url, payload });

  const connect = async (): Promise<void> => {
    await put('/api/integrations/atlassian', {
      settings: {
        enabled: true,
        baseUrl: 'https://acme.atlassian.net',
        email: 'qa@acme.io',
        deployment: 'cloud',
        confluenceUrl: '',
      },
      token: SECRET,
    });
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-int-routes-'));
    mcpConfig = join(dir, '.claude.json');
    writeFileSync(mcpConfig, '{}', 'utf8');
    app = Fastify();
    registerIntegrationsRoutes(
      app,
      {
        store: new AppStore(dir),
        backupDir: undefined,
        location: { paths: { appData: dir, mcpConfig } },
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

  it('список отдаёт все карточки и ни одного токена', async () => {
    await connect();
    const response = await app.inject({ method: 'GET', url: '/api/integrations' });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
    const cards = response.json() as { id: string; hasToken: boolean }[];
    expect(cards).toHaveLength(6);
    expect(cards.find((card) => card.id === 'atlassian')?.hasToken).toBe(true);
  });

  it('неизвестная интеграция — 404 с кодом, а не падение', async () => {
    for (const response of [
      await put('/api/integrations/dropbox', { settings: {} }),
      await post('/api/integrations/dropbox/check'),
      await app.inject({ method: 'DELETE', url: '/api/integrations/dropbox' }),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'integration_not_found' });
    }
  });

  it('битая настройка — 400 с именем поля, а не молчаливое сохранение', async () => {
    const response = await put('/api/integrations/telegram', {
      settings: { enabled: 'да', chatId: '@qa', events: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_body' });
  });

  it('проверка связи отвечает состоянием карточки, а не отказом', async () => {
    await connect();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('denied', { status: 401 })));
    const response = await post('/api/integrations/atlassian/check');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'error' });
    expect(response.body).toContain('токен отклонён');
    expect(response.body).not.toContain(SECRET);
  });

  it('неподключённая система — 404 «не подключена» на каждой ручке', async () => {
    for (const url of [
      '/api/integrations/jira/projects',
      '/api/integrations/jira/search?q=вход',
      '/api/integrations/confluence/spaces',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'integration_not_found' });
    }
  });

  it('поиск и чтение Jira отвечают тем, что вернула система', async () => {
    await connect();
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        String(url).includes('/search')
          ? new Response(
              JSON.stringify({ issues: [{ key: 'PRJ-1', fields: { summary: 'Падает' } }] }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ key: 'PRJ-1', fields: { summary: 'Падает' } }), {
              status: 200,
            }),
      ),
    );
    const search = await app.inject({
      method: 'GET',
      url: '/api/integrations/jira/search?q=падает',
    });
    expect(search.json()).toMatchObject([{ key: 'PRJ-1', summary: 'Падает' }]);

    const issue = await app.inject({ method: 'GET', url: '/api/integrations/jira/issue/PRJ-1' });
    expect(issue.json()).toMatchObject({ key: 'PRJ-1' });
  });

  it('внешняя система не отвечает — 502 с причиной словами', async () => {
    await connect();
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const response = await app.inject({ method: 'GET', url: '/api/integrations/jira/projects' });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: 'integration_unreachable' });
  });

  it('привязка проекта пишется, читается и снимается', async () => {
    const project = join(dir, 'repo');
    const saved = await put('/api/integrations/links', {
      path: project,
      link: { jiraIssueKey: 'PRJ-1', note: '  ' },
    });
    expect(saved.json()).toMatchObject({ project: { jiraIssueKey: 'PRJ-1' } });
    // Пустое поле не сохраняется: `note` из формы пришёл пробелами.
    expect(saved.body).not.toContain('note');

    const read = await app.inject({
      method: 'GET',
      url: `/api/integrations/links?path=${encodeURIComponent(project)}`,
    });
    expect(read.json()).toMatchObject({ project: { jiraIssueKey: 'PRJ-1' } });

    const dropped = await app.inject({
      method: 'DELETE',
      url: '/api/integrations/links',
      payload: { path: project },
    });
    expect(dropped.json()).toEqual({ project: {}, groups: {} });
  });

  it('привязка без каталога — 400 с именем поля', async () => {
    const response = await put('/api/integrations/links', { link: { jiraIssueKey: 'PRJ-1' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_body', detail: 'path' });
  });

  it('подключение переходника пишет запись в конфиг CLI и снимает её обратно', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/integrations/mcp/connect' });
    expect(before.json()).toMatchObject({ connected: false });

    const connected = await post('/api/integrations/mcp/connect');
    expect(connected.json()).toMatchObject({
      name: 'agentdeck-atlassian',
      connected: true,
    });
    const raw = readFileSync(mcpConfig, 'utf8');
    expect(raw).toContain('AGENTDECK_URL');
    expect(raw).not.toContain(SECRET);

    const removed = await app.inject({ method: 'DELETE', url: '/api/integrations/mcp/connect' });
    expect(removed.json()).toMatchObject({ connected: false, removed: true });
  });

  it('Telegram без чата — 404 «не подключена», без запроса наружу', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(String(url));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const response = await post('/api/integrations/telegram/test');
    expect(response.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
