import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { registerIntegrationsRoutes } from '../../integrations-routes/integrations-routes.ts';
import { registerProjectRoutes } from '../../project-routes/project-routes.ts';
import { HARNESS_ORIGIN, manageHarness, type ManageHarness } from '../manage-test-harness.ts';
import { folderSnapshot } from '../registered-folder/registered-folder.test-kit.ts';

/**
 * Чтение Jira и Confluence, привязки проекта и переходник MCP Atlassian — на
 * настоящих маршрутах интеграций и НАСТОЯЩЕМ http-стабе своей установки
 * Atlassian (deployment `server`) на 127.0.0.1. Стаб пишет каждый вызов:
 * доказательство «агент только читает» — в нём нет ни одного не-GET.
 */
const TOKEN = 'ATLASSIAN-PAT-HUMAN-ONLY-Qx81';
const LEAKED = 'sk-ant-api03-LEAKEDLEAKEDLEAKEDLEAKEDLEAKED0000';

const ISSUE = {
  key: 'PRJ-7',
  fields: {
    summary: 'Вход ломается после смены пароля',
    status: { name: 'Open', statusCategory: { key: 'new' } },
    issuetype: { name: 'Bug' },
    assignee: { displayName: 'QA' },
    updated: '2026-09-28T10:00:00.000+0000',
    description: `Шаги: войти. В логе остался ключ ${LEAKED}`,
  },
};

async function startAtlassian(): Promise<{
  url: string;
  calls: Array<{ method: string; path: string; auth?: string }>;
  close: () => Promise<void>;
}> {
  const calls: Array<{ method: string; path: string; auth?: string }> = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    calls.push({
      method: request.method ?? '',
      path: url.pathname,
      ...(request.headers.authorization ? { auth: request.headers.authorization } : {}),
    });
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    request.resume();
    request.on('end', () => {
      if (request.method !== 'GET') return send(405, { message: 'read-only stub' });
      switch (url.pathname) {
        case '/rest/api/2/project':
          return send(200, [{ id: '1', key: 'PRJ', name: 'Проект' }]);
        case '/rest/api/2/search':
          return send(200, { issues: [ISSUE] });
        case '/rest/api/2/issue/PRJ-7':
          return send(200, ISSUE);
        case '/rest/api/space':
          return send(200, { results: [{ id: 5, key: 'DOC', name: 'Документы' }] });
        case '/rest/api/content/search':
          return send(200, {
            results: [
              {
                id: '100',
                title: 'Требования',
                space: { key: 'DOC' },
                version: { number: 3 },
                _links: { webui: '/display/DOC/Req' },
              },
            ],
          });
        case '/rest/api/content/100':
          return send(200, {
            id: '100',
            title: 'Требования',
            space: { key: 'DOC' },
            version: { number: 3 },
            body: { storage: { value: `<p>Первое требование.</p><p>Пароль стенда ${LEAKED}</p>` } },
          });
        default:
          return send(404, { errorMessages: ['Issue does not exist'] });
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('panel-agent actions: integrations read', () => {
  let root: string;
  let appData: string;
  let mcpConfig: string;
  let project: string;
  let stub: Awaited<ReturnType<typeof startAtlassian>>;
  let h: ManageHarness;
  const results: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-integr-x-'));
    appData = join(root, 'agentdeck');
    project = join(root, 'shop');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project, { recursive: true });
    mcpConfig = join(root, '.claude.json');
    writeFileSync(mcpConfig, '{}\n');
    stub = await startAtlassian();
    results.length = 0;
    const store = new AppStore(appData);
    store.addProject({ id: 'p-shop', name: 'shop', path: project });
    const ctx = {
      store,
      backupDir: join(root, 'backups'),
      location: { paths: { root, appData, mcpConfig } },
    } as unknown as ServerContext;
    h = await manageHarness(ctx, (app) => {
      registerIntegrationsRoutes(app, ctx, 'http://127.0.0.1:5178');
      registerProjectRoutes(app, ctx);
    });
    // Подключение — дело человека: адрес и ключ он вводит в карточке интеграции.
    // Jira и Confluence — две карточки; заглушка отвечает за обе.
    for (const id of ['jira', 'confluence']) {
      const saved = await h.app.inject({
        method: 'PUT',
        url: `/api/integrations/${id}`,
        headers: { origin: HARNESS_ORIGIN },
        payload: {
          settings: { enabled: true, baseUrl: stub.url, email: '', deployment: 'server' },
          token: TOKEN,
        },
      });
      expect(saved.statusCode).toBe(200);
    }
  });

  afterEach(async () => {
    await h.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const call = async (name: string, input: unknown) => {
    const result = await h.call(name, input);
    results.push(JSON.stringify(result));
    return result;
  };
  const decided = async (name: string, input: unknown, decision?: 'approve' | 'reject') => {
    const out = await h.decided(name, input, decision);
    results.push(JSON.stringify(out));
    return out;
  };

  it('Jira: проекты, поиск, задача; секрет из описания замаскирован, ключ Atlassian не виден', async () => {
    const projects = await call('jira_projects', {});
    expect(projects.outcome).toBe('done');
    expect(projects.result).toEqual({ projects: [{ key: 'PRJ', name: 'Проект' }] });

    const found = await call('jira_search', { q: 'пароль', limit: 5 });
    expect(found.outcome).toBe('done');
    expect(found.result).toMatchObject({
      issues: [{ key: 'PRJ-7', status: 'Open', statusCategory: 'new', type: 'Bug' }],
    });

    const issue = await call('jira_issue', { key: 'PRJ-7' });
    expect(issue.outcome).toBe('done');
    const text = (issue.result as { description: { text: string } }).description.text;
    expect(text).toContain('Шаги: войти.');
    expect(text).not.toContain(LEAKED);

    // Ключ ушёл в стаб заголовком — и никуда больше.
    expect(stub.calls.some((item) => item.auth?.includes(TOKEN))).toBe(true);
    expect(results.join('\n')).not.toContain(TOKEN);
    expect(results.join('\n')).not.toContain(LEAKED);
  });

  it('Jira: без q и jql — отказ схемы; незнакомая задача — отказ маршрута; в стаб — ни одного не-GET', async () => {
    expect((await call('jira_search', {})).outcome).toBe('invalid');
    const missing = await call('jira_issue', { key: 'PRJ-404' });
    expect(missing.outcome).toBe('failed');
    expect(stub.calls.every((item) => item.method === 'GET')).toBe(true);
  });

  it('Confluence: пространства, поиск, страница окном; секрет страницы замаскирован', async () => {
    const spaces = await call('confluence_spaces', {});
    expect(spaces.result).toEqual({ spaces: [{ key: 'DOC', name: 'Документы' }] });

    const found = await call('confluence_search', { q: 'требования' });
    expect(found.outcome).toBe('done');
    expect(found.result).toMatchObject({
      pages: [{ id: '100', title: 'Требования', space: 'DOC', version: 3 }],
    });

    const page = await call('confluence_page', { id: '100' });
    expect(page.outcome).toBe('done');
    const body = (page.result as { body: { text: string } }).body.text;
    expect(body).toContain('Первое требование.');
    expect(body).not.toContain(LEAKED);

    expect((await call('confluence_search', { q: '' })).outcome).toBe('invalid');
    expect((await call('confluence_page', { id: '404' })).outcome).toBe('failed');
    expect(stub.calls.every((item) => item.method === 'GET')).toBe(true);
  });

  it('links of a folder the panel does not know — read, save and remove refused before a card', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'README.md'), '# outside\n');
    // Привязка, поставленная человеком раньше: снятие агентом до правки её бы стёрло.
    await h.app.inject({
      method: 'PUT',
      url: '/api/integrations/links',
      headers: { origin: HARNESS_ORIGIN },
      payload: { path: outside, link: { jiraIssueKey: 'OUT-1' } },
    });
    const stored = async () =>
      (
        await h.app.inject({
          method: 'GET',
          url: `/api/integrations/links?path=${encodeURIComponent(outside)}`,
        })
      ).json<unknown>();
    const linksBefore = await stored();
    const before = folderSnapshot(outside);

    /** Вызов записи с одобрением карточки; отказ до карточки — без неё. */
    const attempt = async (name: string, input: unknown) => {
      try {
        const { result } = await h.decided(name, input);
        return { carded: true, outcome: result.outcome, message: result.message ?? '' };
      } catch (error) {
        const found = /^no card: (\S+) ?([\s\S]*)$/.exec((error as Error).message);
        if (!found) throw error;
        return { carded: false, outcome: found[1], message: found[2] ?? '' };
      }
    };
    const read = await call('list_integration_links', { path: outside });
    const seen: Record<string, unknown> = {
      list_integration_links: {
        carded: false,
        outcome: read.outcome,
        notRegistered: (read.message ?? '').includes('not registered'),
      },
    };
    for (const [name, input] of [
      ['save_integration_link', { path: outside, jiraIssueKey: 'OUT-2' }],
      ['remove_integration_link', { path: outside }],
    ] as const) {
      const { carded, outcome, message } = await attempt(name, input);
      seen[name] = { carded, outcome, notRegistered: message.includes('not registered') };
    }
    const refused = { carded: false, outcome: 'failed', notRegistered: true };
    expect(seen).toEqual({
      list_integration_links: refused,
      save_integration_link: refused,
      remove_integration_link: refused,
    });
    expect(await stored()).toEqual(linksBefore);
    expect(folderSnapshot(outside)).toEqual(before);
  });

  it('привязки: запись карточкой только названных полей, чтение, снятие danger; пустое снятие — отказ', async () => {
    const empty = await call('list_integration_links', { path: project });
    expect(empty.result).toEqual({ project: {}, groups: {} });

    const saved = await decided('save_integration_link', {
      path: project,
      jiraIssueKey: 'PRJ-7',
      confluencePageId: '100',
    });
    expect(saved.card.risk).toBe('change');
    expect(saved.card.preview.diff).toContain('PRJ-7');
    expect(saved.result.outcome).toBe('done');

    await decided('save_integration_link', { path: project, note: 'регресс входа' });
    const read = await call('list_integration_links', { path: project });
    expect(read.result).toMatchObject({
      project: { jiraIssueKey: 'PRJ-7', confluencePageId: '100', note: 'регресс входа' },
    });

    const group = await decided('save_integration_link', {
      path: project,
      groupId: 'smoke',
      jiraProjectKey: 'PRJ',
    });
    expect(group.result.outcome).toBe('done');
    // Ключ в заметке карточка прячет, ключ задачи и проекта — нет.
    const leaky = await decided('save_integration_link', {
      path: project,
      groupId: 'smoke',
      note: `стенд ${LEAKED}`,
    });
    expect(leaky.card.preview.diff).toContain('"jiraProject": "PRJ"');
    expect(leaky.card.preview.diff).not.toContain(LEAKED);

    const removed = await decided('remove_integration_link', { path: project });
    expect(removed.card.risk).toBe('danger');
    expect(removed.result.outcome).toBe('done');
    const after = (await call('list_integration_links', { path: project })).result as {
      project: object;
      groups: Record<string, object>;
    };
    expect(after.project).toEqual({});
    // Снятие привязки проекта не трогает привязку группы.
    expect(after.groups.smoke).toMatchObject({ jiraProjectKey: 'PRJ' });
    expect(results.join('\n')).not.toContain(LEAKED);

    const again = await call('remove_integration_link', { path: project });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('no link');
    expect(await h.pendingCards()).toEqual([]);
    // Привязка — локальная заметка: в Atlassian ничего не ушло.
    expect(stub.calls.every((item) => item.method === 'GET')).toBe(true);
  });

  it('MCP Atlassian: подключает только человек; агент лишь отключает, отказ человека — файл цел', async () => {
    // Подключение — не действие модели: такого действия нет, конфигурация не тронута.
    const connect = await call('atlassian_mcp_connect', { connect: true });
    expect(connect.outcome).toBe('unknown');
    expect(readFileSync(mcpConfig, 'utf8')).toBe('{}\n');
    const nothing = await call('atlassian_mcp_disconnect', {});
    expect(nothing.outcome).toBe('failed');
    expect(nothing.message).toContain('not connected');

    // Кнопка человека — прямой маршрут панели; в записи нет токена.
    const button = await h.app.inject({ method: 'POST', url: '/api/integrations/mcp/connect' });
    expect(button.statusCode).toBe(200);
    const written = readFileSync(mcpConfig, 'utf8');
    expect(Object.keys((JSON.parse(written) as { mcpServers: object }).mcpServers)).toHaveLength(1);
    expect(written).not.toContain(TOKEN);

    const rejected = await decided('atlassian_mcp_disconnect', {}, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(readFileSync(mcpConfig, 'utf8')).toBe(written);

    const { card, result } = await decided('atlassian_mcp_disconnect', {});
    expect(card.preview.summaryCode).toBe('summary-atlassian-mcp-disconnect');
    expect(result.outcome).toBe('done');
    const after = JSON.parse(readFileSync(mcpConfig, 'utf8')) as { mcpServers?: object };
    expect(Object.keys(after.mcpServers ?? {})).toHaveLength(0);
  });
});
