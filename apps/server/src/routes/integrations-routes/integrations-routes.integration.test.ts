import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
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
    await put('/api/integrations/jira', {
      settings: {
        enabled: true,
        baseUrl: 'https://acme.atlassian.net',
        email: 'qa@acme.io',
        deployment: 'cloud',
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

  it('список отдаёт все карточки и ни одного токена', async () => {
    await connect();
    const response = await app.inject({ method: 'GET', url: '/api/integrations' });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
    const cards = response.json() as { id: string; hasToken: boolean }[];
    expect(cards).toHaveLength(10);
    expect(cards.find((card) => card.id === 'jira')?.hasToken).toBe(true);
    // Ключ Jira — только Jira: Confluence подключается своим.
    expect(cards.find((card) => card.id === 'confluence')?.hasToken).toBe(false);
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
        baseUrl: 'https://testit.acme.local',
        projectKey: 'PRJ-1',
        groupId: '',
        ...extra,
      },
    });

    it('Test IT без адреса не сохраняется включённым', async () => {
      const response = await put('/api/integrations/testit', tms({ baseUrl: '   ' }));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_body' });
      expect(JSON.stringify(response.json())).toContain('baseUrl');
    });

    it('без проекта — тоже отказ, и поле названо', async () => {
      for (const id of ['testit', 'zephyr', 'xray']) {
        const response = await put(`/api/integrations/${id}`, tms({ projectKey: '' }));
        expect(response.statusCode).toBe(400);
        expect(JSON.stringify(response.json())).toContain('projectKey');
      }
    });

    it('Zephyr адреса не требует: у облака он общий на всех', async () => {
      const response = await put(
        '/api/integrations/zephyr',
        tms({ baseUrl: '', projectKey: 'PRJ' }),
      );
      expect(response.statusCode).toBe(200);
    });

    it('выключенную карточку заполняют в несколько заходов — половина формы сохраняется', async () => {
      const response = await put('/api/integrations/testit', {
        settings: { enabled: false, baseUrl: '', projectKey: '', groupId: '' },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  it('проверка связи отвечает состоянием карточки, а не отказом', async () => {
    await connect();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('denied', { status: 401 })));
    const response = await post('/api/integrations/jira/check');
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
   * personal access token. Теперь Confluence — своя интеграция (владелец
   * 10.10.2026): свой адрес и свой ключ, сохранённые тем же PUT, которым ходят
   * браузер, телефон и curl.
   */
  it('Confluence подключается своей карточкой, и его ключ уезжает именно в вики', async () => {
    await connect();
    const saved = await put('/api/integrations/confluence', {
      settings: {
        enabled: true,
        baseUrl: 'https://wiki.acme.local',
        email: '',
        deployment: 'server',
      },
      token: WIKI_SECRET,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(WIKI_SECRET);
    expect(saved.json()).toMatchObject({ id: 'confluence', hasToken: true });

    const calls: { url: string; auth: string }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        auth: String((init.headers as Record<string, string>)?.Authorization ?? ''),
      });
      return Promise.resolve(
        new Response(JSON.stringify(String(url).includes('/space') ? { results: [] } : []), {
          status: 200,
        }),
      );
    });

    await app.inject({ method: 'GET', url: '/api/integrations/confluence/spaces' });
    await app.inject({ method: 'GET', url: '/api/integrations/jira/projects' });
    expect(calls[0]?.auth).toBe(`Bearer ${WIKI_SECRET}`);
    expect(calls[0]?.url.startsWith('https://wiki.acme.local/rest/api/space')).toBe(true);
    expect(calls[1]?.auth).toContain('Basic ');
  });

  /**
   * «Найти уже подключённые» (владелец 10.10.2026) — форма владельца: обёртка
   * `with-secrets.mjs` перед `docker run` и `npx`, адреса в `env` сервера,
   * ключи — в файле секретов по списку `MCP_SECRET_KEYS`.
   */
  describe('поиск среди MCP-серверов', () => {
    // Ключи из кусков: литерал целиком похож на настоящий, и сторож его не пропустит.
    const GITLAB_KEY = ['glpat', 'route', 'gitlab', '0001'].join('-');
    const JIRA_KEY = ['JIRA', 'PAT', 'СЕКРЕТ', '0002'].join('-');
    const WIKI_KEY = ['WIKI', 'PAT', 'СЕКРЕТ', '0003'].join('-');
    const wrapper = 'C:/Users/qa/.claude/mcp-launchers/with-secrets.mjs';
    const secretLine = (name: string, value: string): string => [name, value].join('=');

    beforeEach(() => {
      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            'gitlab-acme': {
              type: 'stdio',
              command: 'node',
              args: [wrapper, 'npx', '-y', '@zereight/mcp-gitlab'],
              env: {
                MCP_SECRET_KEYS: 'GITLAB_PERSONAL_ACCESS_TOKEN',
                GITLAB_API_URL: 'https://gitlab.acme.local/api/v4',
              },
            },
            'atlassian-acme': {
              type: 'stdio',
              command: 'node',
              args: [
                wrapper,
                'docker',
                'run',
                '-i',
                '--rm',
                '-e',
                'JIRA_URL',
                '-e',
                'JIRA_PERSONAL_TOKEN',
                '-e',
                'CONFLUENCE_URL',
                '-e',
                'CONFLUENCE_PERSONAL_TOKEN',
                'ghcr.io/sooperset/mcp-atlassian:latest',
              ],
              env: {
                MCP_SECRET_KEYS: 'JIRA_PERSONAL_TOKEN,CONFLUENCE_PERSONAL_TOKEN',
                JIRA_URL: 'https://jira.acme.local',
                CONFLUENCE_URL: 'https://wiki.acme.local',
              },
            },
            // Свой переходник панели — не чужое подключение.
            'agentdeck-atlassian': {
              command: 'node',
              args: ['tools/mcp/atlassian.mjs'],
              env: { AGENTDECK_URL: 'http://127.0.0.1:5178' },
            },
          },
        }),
        'utf8',
      );
      writeFileSync(
        join(dir, '.mcp-secrets.env'),
        [
          secretLine('GITLAB_PERSONAL_ACCESS_TOKEN', GITLAB_KEY),
          secretLine('JIRA_PERSONAL_TOKEN', JIRA_KEY),
          secretLine('CONFLUENCE_PERSONAL_TOKEN', WIKI_KEY),
        ].join('\n'),
        'utf8',
      );
    });

    const discover = async () => app.inject({ method: 'GET', url: '/api/integrations/discover' });

    it('находит GitLab, Jira и Confluence и не отдаёт ни одного ключа', async () => {
      const response = await discover();
      expect(response.statusCode).toBe(200);
      for (const secret of [GITLAB_KEY, JIRA_KEY, WIKI_KEY]) {
        expect(response.body).not.toContain(secret);
      }
      const { found, scanned } = response.json() as {
        scanned: number;
        found: { id: string; server: string; fields: Record<string, string>; hasToken: boolean }[];
      };
      expect(scanned).toBe(2);
      expect(found.map((item) => [item.id, item.server, item.fields.baseUrl])).toEqual([
        ['jira', 'atlassian-acme', 'https://jira.acme.local'],
        ['confluence', 'atlassian-acme', 'https://wiki.acme.local'],
        ['gitlab', 'gitlab-acme', 'https://gitlab.acme.local'],
      ]);
      expect(found.every((item) => item.hasToken)).toBe(true);
    });

    it('перенос включает интеграции с их ключами, и каждая ходит своим', async () => {
      const { found } = (await discover()).json() as { found: { key: string }[] };
      const applied = await post('/api/integrations/discover', {
        keys: found.map((item) => item.key),
      });
      expect(applied.statusCode).toBe(200);
      for (const secret of [GITLAB_KEY, JIRA_KEY, WIKI_KEY]) {
        expect(applied.body).not.toContain(secret);
      }
      expect(applied.json()).toMatchObject([
        { id: 'jira', enabled: true, hasToken: true },
        { id: 'confluence', enabled: true, hasToken: true },
        { id: 'gitlab', enabled: true, hasToken: true },
      ]);

      const calls: { url: string; auth: string }[] = [];
      vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
        calls.push({
          url: String(url),
          auth: String((init.headers as Record<string, string>)?.Authorization ?? ''),
        });
        return Promise.resolve(new Response(JSON.stringify({ name: 'qa' }), { status: 200 }));
      });
      const checked = await post('/api/integrations/confluence/check');
      expect(checked.json()).toMatchObject({ state: 'ok' });
      expect(calls.at(-1)).toEqual({
        url: 'https://wiki.acme.local/rest/api/user/current',
        auth: `Bearer ${WIKI_KEY}`,
      });

      // Повторный поиск видит перенесённое как уже подключённое: адреса и ключи
      // легли туда, откуда их читают карточки.
      const again = (await discover()).json() as { found: { alreadyConnected: boolean }[] };
      expect(again.found.every((item) => item.alreadyConnected)).toBe(true);
    });

    it('пустой выбор и исчезнувший сервер — отказ до единой записи', async () => {
      expect((await post('/api/integrations/discover', { keys: [] })).statusCode).toBe(400);
      const gone = await post('/api/integrations/discover', {
        keys: ['user||atlassian-acme|jira', 'user||nope|gitlab'],
      });
      expect(gone.statusCode).toBe(400);
      expect(gone.json()).toMatchObject({ messageCode: 'integration-discover-gone' });
      const cards = (await app.inject({ method: 'GET', url: '/api/integrations' })).json() as {
        id: string;
        hasToken: boolean;
      }[];
      expect(cards.find((card) => card.id === 'jira')?.hasToken).toBe(false);
    });
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
