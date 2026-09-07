import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store.ts';
import { writeLink } from '../integrations/links.ts';
import { writeSettings, writeToken } from '../integrations/store.ts';
import { readGroups } from './store.ts';
import { buildCoverage, requirementKey, type CoverageDeps } from './coverage.ts';

/**
 * Матрица покрытия. Главное свойство — она отвечает на вопрос «чего мы НЕ
 * проверяем», и потому проверяется в первую очередь то, из-за чего дыра
 * пропала бы с экрана: один ключ на разные адреса задачи, требование без
 * кейсов вверху списка и живая матрица при мёртвой Jira.
 */

let dir: string;
let store: AppStore;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-cov-'));
  store = new AppStore(dir);
  root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const deps = (): CoverageDeps => ({ store, appDataDir: dir, root });

function writeGroup(id: string, cases: unknown[]): void {
  const groupDir = join(root, '.agent', 'tests');
  mkdirSync(groupDir, { recursive: true });
  writeFileSync(join(groupDir, `${id}.tests.json`), JSON.stringify({ version: 1, cases }, null, 2));
}

/** Кейс минимальной полноты: у матрицы важны только ссылки и статус. */
function testCase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gui-001',
    type: 'case',
    title: 'Вход с верными данными',
    status: 'passed',
    source: 'human',
    ...over,
  };
}

function connectJira(): void {
  writeSettings(store, 'atlassian', {
    enabled: true,
    baseUrl: 'https://acme.atlassian.net',
    email: 'qa@acme.io',
    deployment: 'cloud',
    confluenceUrl: '',
  });
  writeToken(dir, 'atlassian', 'ATL-SECRET');
}

function stubSearch(reply: { status?: number; body?: unknown }): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(String(url));
    return Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
      }),
    );
  });
  return { urls };
}

const issue = (key: string, summary: string, status = 'In Progress') => ({
  key,
  fields: { summary, status: { name: status, statusCategory: { key: 'indeterminate' } } },
});

describe('project-tests/coverage: ключ требования', () => {
  it('разные адреса одной задачи дают один столбец', () => {
    expect(requirementKey('https://acme.atlassian.net/browse/QA-42')).toBe('QA-42');
    expect(requirementKey('https://acme.atlassian.net/browse/qa-42')).toBe('QA-42');
    expect(
      requirementKey('https://acme.atlassian.net/jira/software/projects/QA/issues/QA-42'),
    ).toBe('QA-42');
  });

  it('не задача Jira — ключом остаётся сам адрес', () => {
    expect(requirementKey(' https://wiki.acme/spec/login ')).toBe('https://wiki.acme/spec/login');
  });
});

describe('project-tests/coverage: матрица по ссылкам', () => {
  it('кейсы собираются под требование, а беспризорные — отдельно', async () => {
    writeGroup('gui', [
      testCase({
        id: 'gui-001',
        links: [{ type: 'requirement', url: 'https://acme.atlassian.net/browse/QA-42' }],
      }),
      testCase({
        id: 'gui-002',
        status: 'failed',
        links: [{ type: 'issue', url: 'https://acme.atlassian.net/browse/qa-42', title: 'Вход' }],
      }),
      testCase({ id: 'gui-003' }),
    ]);

    const coverage = await buildCoverage(deps(), readGroups(root), { linksOnly: true });

    expect(coverage.source).toBe('links');
    expect(coverage.items).toHaveLength(1);
    expect(coverage.items[0]).toMatchObject({
      key: 'QA-42',
      title: 'Вход',
      counts: { passed: 1, failed: 1, blocked: 0, skipped: 0, unknown: 0 },
    });
    expect(coverage.items[0]!.cases.map((one) => one.caseId)).toEqual(['gui-001', 'gui-002']);
    expect(coverage.orphans.map((one) => one.caseId)).toEqual(['gui-003']);
  });

  it('идущий прогон считается непроверенным, а не зелёным', async () => {
    writeGroup('gui', [
      testCase({
        status: 'running',
        links: [{ type: 'requirement', url: 'https://acme.atlassian.net/browse/QA-7' }],
      }),
    ]);

    const coverage = await buildCoverage(deps(), readGroups(root), { linksOnly: true });
    expect(coverage.items[0]!.counts).toMatchObject({ passed: 0, unknown: 1 });
  });

  it('архивный кейс не закрывает требование собой', async () => {
    writeGroup('gui', [
      testCase({
        archived: true,
        links: [{ type: 'requirement', url: 'https://acme.atlassian.net/browse/QA-9' }],
      }),
    ]);

    const coverage = await buildCoverage(deps(), readGroups(root), { linksOnly: true });
    expect(coverage.items).toEqual([]);
    expect(coverage.orphans).toEqual([]);
  });

  it('ссылка на документацию требованием не считается', async () => {
    writeGroup('gui', [testCase({ links: [{ type: 'doc', url: 'https://wiki.acme/how-to' }] })]);

    const coverage = await buildCoverage(deps(), readGroups(root), { linksOnly: true });
    expect(coverage.items).toEqual([]);
    expect(coverage.orphans).toHaveLength(1);
  });
});

describe('project-tests/coverage: требования из Jira', () => {
  it('задача, на которую не сослался никто, попадает в матрицу пустой и первой', async () => {
    connectJira();
    writeLink(store, root, undefined, { jiraProjectKey: 'QA' });
    writeGroup('gui', [
      testCase({
        links: [{ type: 'requirement', url: 'https://acme.atlassian.net/browse/QA-42' }],
      }),
    ]);
    const { urls } = stubSearch({
      body: { issues: [issue('QA-42', 'Вход'), issue('QA-77', 'Выход')] },
    });

    const coverage = await buildCoverage(deps(), readGroups(root));

    expect(coverage.source).toBe('jira');
    expect(coverage.jql).toBe('project = QA AND statusCategory != Done ORDER BY key ASC');
    expect(urls[0]).toContain('project%20%3D%20QA');
    expect(coverage.items.map((one) => one.key)).toEqual(['QA-77', 'QA-42']);
    expect(coverage.items[0]).toMatchObject({ key: 'QA-77', title: 'Выход', cases: [] });
    expect(coverage.items[1]!.status).toBe('In Progress');
  });

  it('привязка к эпику спрашивает его детей', async () => {
    connectJira();
    writeLink(store, root, undefined, { jiraProjectKey: 'QA', jiraIssueKey: 'QA-1' });
    const { urls } = stubSearch({ body: { issues: [] } });

    const coverage = await buildCoverage(deps(), readGroups(root));
    expect(coverage.jql).toBe('parent = QA-1 ORDER BY key ASC');
    expect(urls[0]).toContain('parent');
  });

  it('свой запрос JQL сильнее привязки', async () => {
    connectJira();
    writeLink(store, root, undefined, { jiraProjectKey: 'QA' });
    stubSearch({ body: { issues: [] } });

    const coverage = await buildCoverage(deps(), readGroups(root), { jql: '  labels = smoke  ' });
    expect(coverage.jql).toBe('labels = smoke');
  });

  it('мёртвая Jira не отменяет матрицу — она объясняется оговоркой', async () => {
    connectJira();
    writeLink(store, root, undefined, { jiraProjectKey: 'QA' });
    writeGroup('gui', [
      testCase({
        links: [{ type: 'requirement', url: 'https://acme.atlassian.net/browse/QA-42' }],
      }),
    ]);
    stubSearch({ status: 500, body: { message: 'boom' } });

    const coverage = await buildCoverage(deps(), readGroups(root));
    expect(coverage.source).toBe('links');
    expect(coverage.items.map((one) => one.key)).toEqual(['QA-42']);
    expect(coverage.warning).toContain('Jira не ответила');
  });

  it('без подключения и без привязки в сеть не ходят вовсе', async () => {
    const { urls } = stubSearch({ body: { issues: [] } });
    const noAtlassian = await buildCoverage(deps(), readGroups(root));
    expect(noAtlassian.warning).toContain('Atlassian не подключён');

    connectJira();
    const noLink = await buildCoverage(deps(), readGroups(root));
    expect(noLink.warning).toContain('не привязан проект Jira');
    expect(urls).toEqual([]);
  });
});
