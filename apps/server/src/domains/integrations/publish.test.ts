import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import { createGroup, upsertCase } from '../project-tests/store.ts';
import { writeRun } from '../project-tests/runs-store.ts';
import { writeLink } from './links.ts';
import { commentText, markdownToStorage, publishRun } from './publish.ts';
import { writeSettings, writeToken } from './store.ts';

/**
 * Публикация отчёта наружу. Проверяется главное: отчёт не пишется заново, адрес
 * берётся только из привязки, а привязанная страница Confluence НЕ
 * перезаписывается — отчёт ложится дочерней.
 */

let project = '';
let appData = '';
let store: AppStore;

const RUN: ProjectTestRunRecord = {
  id: 'run-1',
  mode: 'run',
  actor: 'agent',
  status: 'done',
  branch: 'qa/login',
  startedAt: '2026-09-07T10:00:00.000Z',
  finishedAt: '2026-09-07T10:20:00.000Z',
  results: [
    { pointId: 'p1', groupId: 'gui', caseId: 'gui-001', status: 'failed', note: 'кнопка серая' },
  ],
  summary: { total: 1, passed: 0, failed: 1, skipped: 0, blocked: 0 },
};

function stubApi(routes: [RegExp, { status?: number; body?: unknown }][]): {
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const found = routes.find(([pattern]) => pattern.test(String(url)));
    const reply = found?.[1] ?? { status: 404, body: {} };
    return Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
      }),
    );
  });
  return { calls };
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cc-publish-'));
  appData = mkdtempSync(join(tmpdir(), 'cc-publish-data-'));
  store = new AppStore(appData);
  createGroup(project, 'gui', 'GUI');
  upsertCase(project, 'gui', { title: 'Вход', steps: [] }, '2026-09-01T10:00:00.000Z');
  writeRun(project, RUN);
  writeSettings(store, 'atlassian', {
    enabled: true,
    baseUrl: 'https://acme.atlassian.net',
    email: 'qa@acme.io',
    deployment: 'cloud',
    confluenceUrl: '',
  });
  writeToken(appData, 'atlassian', 'SECRET');
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(project, { recursive: true, force: true });
  rmSync(appData, { recursive: true, force: true });
});

const deps = (): { store: AppStore; appDataDir: string } => ({ store, appDataDir: appData });

describe('domains/integrations/publish', () => {
  it('нет прогона — 404 с его именем', async () => {
    writeLink(store, project, undefined, { jiraIssueKey: 'PRJ-1' });
    await expect(
      publishRun(deps(), { path: project, runId: 'нет-такого', target: 'jira' }),
    ).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('нет-такого') });
  });

  it('пустые поля запроса — 400 с именем поля', async () => {
    await expect(
      publishRun(deps(), { path: '  ', runId: 'run-1', target: 'jira' }),
    ).rejects.toMatchObject({ detail: 'path' });
    await expect(
      publishRun(deps(), { path: project, runId: ' ', target: 'jira' }),
    ).rejects.toMatchObject({ detail: 'id' });
    await expect(
      publishRun(deps(), {
        path: project,
        runId: 'run-1',
        target: 'nowhere' as unknown as 'jira',
      }),
    ).rejects.toMatchObject({ detail: 'target' });
  });

  it('ничего не привязано — отказ называет, чего не хватает', async () => {
    await expect(
      publishRun(deps(), { path: project, runId: 'run-1', target: 'jira' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('ничего не привязано') });
  });

  it('привязана страница, а публикуют в Jira — отказ, а не публикация «куда-нибудь»', async () => {
    writeLink(store, project, undefined, { confluencePageId: '12' });
    await expect(
      publishRun(deps(), { path: project, runId: 'run-1', target: 'jira' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('не привязана задача Jira') });
  });

  it('Jira: комментарий к привязанной задаче, без таблицы проходов', async () => {
    writeLink(store, project, undefined, { jiraIssueKey: 'PRJ-1' });
    const { calls } = stubApi([[/comment/, { body: {} }]]);

    await expect(
      publishRun(deps(), { path: project, runId: 'run-1', target: 'jira' }),
    ).resolves.toEqual({ url: 'https://acme.atlassian.net/browse/PRJ-1', created: false });

    const sent = JSON.stringify(JSON.parse(String(calls[0]!.init.body)));
    expect(sent).toContain('Что упало');
    expect(sent).toContain('кнопка серая');
    expect(sent).not.toContain('Проходы');
  });

  it('Confluence: отчёт ложится ДОЧЕРНЕЙ страницей, требования не переписываются', async () => {
    writeLink(store, project, undefined, { confluencePageId: '12' });
    const { calls } = stubApi([
      [/api\/v2\/pages\/12\?/, { body: { id: 12, title: 'Требования', spaceId: '5' } }],
      [/api\/v2\/spaces\/5/, { body: { key: 'QA' } }],
      [/api\/v2\/spaces\?keys=QA/, { body: { results: [{ id: '5', key: 'QA' }] } }],
      [
        /api\/v2\/pages$/,
        { body: { id: 99, title: 'Прогон', _links: { webui: '/spaces/QA/pages/99' } } },
      ],
    ]);

    await expect(
      publishRun(deps(), { path: project, runId: 'run-1', target: 'confluence' }),
    ).resolves.toEqual({
      url: 'https://acme.atlassian.net/wiki/spaces/QA/pages/99',
      created: true,
    });

    // Ни одного PUT: привязанная страница только читалась.
    expect(calls.some((call) => call.init.method === 'PUT')).toBe(false);
    const created = JSON.parse(String(calls.at(-1)!.init.body)) as {
      parentId: string;
      title: string;
      body: { value: string };
    };
    expect(created.parentId).toBe('12');
    expect(created.title).toContain('Требования');
    expect(created.body.value).toContain('<h1>');
  });

  it('привязка группы сильнее проектной', async () => {
    writeLink(store, project, undefined, { jiraIssueKey: 'PRJ-1' });
    writeLink(store, project, 'gui', { jiraIssueKey: 'PRJ-99' });
    stubApi([[/comment/, { body: {} }]]);
    await expect(
      publishRun(deps(), { path: project, runId: 'run-1', target: 'jira', groupId: 'gui' }),
    ).resolves.toMatchObject({ url: 'https://acme.atlassian.net/browse/PRJ-99' });
  });

  it('Atlassian не подключён — 404, а не попытка сходить в сеть', async () => {
    writeLink(store, project, undefined, { jiraIssueKey: 'PRJ-1' });
    writeSettings(store, 'atlassian', {
      enabled: false,
      baseUrl: 'https://acme.atlassian.net',
      email: 'qa@acme.io',
      deployment: 'cloud',
      confluenceUrl: '',
    });
    const { calls } = stubApi([]);
    await expect(
      publishRun(deps(), { path: project, runId: 'run-1', target: 'jira' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toHaveLength(0);
  });
});

describe('markdown отчёта → storage Confluence', () => {
  it('заголовки, список и таблица переводятся, а не уезжают текстом', () => {
    const storage = markdownToStorage(
      [
        '# Прогон',
        '',
        '- **Ветка:** qa/login',
        '- Коммит: abc',
        '',
        '## Проходы',
        '',
        '| Кейс | Статус |',
        '| --- | --- |',
        '| Вход | провален |',
        '',
      ].join('\n'),
    );
    expect(storage).toContain('<h1>Прогон</h1>');
    expect(storage).toContain('<li><strong>Ветка:</strong> qa/login</li>');
    expect(storage).toContain('<th>Кейс</th>');
    expect(storage).toContain('<td>провален</td>');
  });

  it('угловые скобки и амперсанды в заметке не ломают страницу', () => {
    expect(markdownToStorage('Ответ <b>&amp; хвост')).toBe('<p>Ответ &lt;b&gt;&amp;amp; хвост</p>');
  });

  it('комментарий Jira обрезается перед таблицей, а без неё остаётся целым', () => {
    expect(commentText('# Шапка\n\n## Что упало\n\nнет\n\n## Проходы\n\n| a |')).toBe(
      '# Шапка\n\n## Что упало\n\nнет',
    );
    expect(commentText('# Шапка\n\nвсё')).toBe('# Шапка\n\nвсё');
  });
});
