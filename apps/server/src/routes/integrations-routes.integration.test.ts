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
  const WIKI_SECRET = 'CONFLUENCE-PAT-СЕКРЕТ-77';

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

  /**
   * Находка M7 ревью Т9: карточка тест-менеджмента включалась без адреса.
   * Проверка идёт через настоящий PUT — тем же маршрутом ходят телефон и curl,
   * а форма браузера была единственным местом, где правило вообще жило.
   */
  describe('включённый тест-менеджмент обязан быть рабочим', () => {
    const tms = (extra: Record<string, unknown>) => ({
      settings: {
        enabled: true,
        kind: 'testit',
        baseUrl: 'https://testit.acme.local',
        projectKey: 'PRJ-1',
        groupId: '',
        ...extra,
      },
    });

    it('Test IT без адреса не сохраняется включённым', async () => {
      const response = await put('/api/integrations/tms', tms({ baseUrl: '   ' }));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_body' });
      expect(JSON.stringify(response.json())).toContain('baseUrl');
    });

    it('без вида и без проекта — тоже отказ, и поле названо', async () => {
      for (const [field, patch] of [
        ['kind', { kind: '' }],
        ['projectKey', { projectKey: '' }],
      ] as const) {
        const response = await put('/api/integrations/tms', tms(patch));
        expect(response.statusCode).toBe(400);
        expect(JSON.stringify(response.json())).toContain(field);
      }
    });

    it('Zephyr адреса не требует: у облака он общий на всех', async () => {
      const response = await put(
        '/api/integrations/tms',
        tms({ kind: 'zephyr', baseUrl: '', projectKey: 'PRJ' }),
      );
      expect(response.statusCode).toBe(200);
    });

    it('выключенную карточку заполняют в несколько заходов — половина формы сохраняется', async () => {
      const response = await put('/api/integrations/tms', {
        settings: { enabled: false, kind: 'testit', baseUrl: '', projectKey: '', groupId: '' },
      });
      expect(response.statusCode).toBe(200);
    });
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

  /**
   * Дефект 18.09.2026, найден живьём на Server/DC: `GET .../confluence/spaces`
   * отвечал 502 «токен отклонён» при рабочей Jira — у Confluence там свой
   * personal access token, а панель посылала ключ Jira.
   *
   * Проверка идёт НАСТОЯЩИМ маршрутом: тем же PUT ходят браузер, телефон и
   * curl, и ровно на нём ключ должен разделиться.
   */
  it('второй ключ Confluence сохраняется маршрутом и уезжает именно в вики', async () => {
    await connect();
    const saved = await put('/api/integrations/atlassian', {
      settings: {
        enabled: true,
        baseUrl: 'https://jira.acme.local',
        email: '',
        deployment: 'server',
        confluenceUrl: 'https://wiki.acme.local',
      },
      confluenceToken: WIKI_SECRET,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(WIKI_SECRET);
    expect(saved.json()).toMatchObject({ hasToken: true, hasConfluenceToken: true });

    const headers: string[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      headers.push(String((init.headers as Record<string, string>)?.Authorization ?? ''));
      return Promise.resolve(
        new Response(JSON.stringify(String(url).includes('/space') ? { results: [] } : []), {
          status: 200,
        }),
      );
    });

    await app.inject({ method: 'GET', url: '/api/integrations/confluence/spaces' });
    await app.inject({ method: 'GET', url: '/api/integrations/jira/projects' });
    expect(headers[0]).toBe(`Bearer ${WIKI_SECRET}`);
    expect(headers[1]).toBe(`Bearer ${SECRET}`);
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
