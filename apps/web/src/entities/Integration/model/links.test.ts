import { describe, it, expect } from 'vitest';
import type { AtlassianSiteSettings } from '@agentdeck/contracts';
import { jiraIssueUrl } from './links';
import { confluencePageUrl } from './confluencePageUrl';
import { linkRows } from './linkRows';

const cloud: AtlassianSiteSettings = {
  enabled: true,
  baseUrl: 'https://site.atlassian.net/',
  email: 'qa@example.com',
  deployment: 'cloud',
};

const server: AtlassianSiteSettings = {
  enabled: true,
  baseUrl: 'https://wiki.company.ru',
  email: '',
  deployment: 'server',
};

/** Jira и Confluence — свои адреса: у своей установки это разные хосты. */
const sites = { jira: cloud, confluence: cloud };

describe('jiraIssueUrl', () => {
  it('собирает адрес задачи и срезает хвостовой слэш адреса', () => {
    expect(jiraIssueUrl(cloud.baseUrl, 'QA-12')).toBe('https://site.atlassian.net/browse/QA-12');
  });

  it('без адреса или без ключа ссылки нет', () => {
    expect(jiraIssueUrl('', 'QA-12')).toBe('');
    expect(jiraIssueUrl(cloud.baseUrl, undefined)).toBe('');
  });
});

describe('confluencePageUrl', () => {
  it('облако ищет страницы под /wiki', () => {
    expect(confluencePageUrl(cloud, '42')).toBe(
      'https://site.atlassian.net/wiki/pages/viewpage.action?pageId=42',
    );
  });

  it('своя установка — в корне своего адреса', () => {
    expect(confluencePageUrl(server, '42')).toBe(
      'https://wiki.company.ru/pages/viewpage.action?pageId=42',
    );
  });

  it('адрес вики облака с /wiki не удваивается; вид не записан — решает почта', () => {
    const wiki = { ...cloud, baseUrl: 'https://site.atlassian.net/wiki/' };
    expect(confluencePageUrl(wiki, '42')).toBe(
      'https://site.atlassian.net/wiki/pages/viewpage.action?pageId=42',
    );
    expect(confluencePageUrl({ ...cloud, deployment: '' }, '42')).toContain('/wiki/pages/');
    expect(confluencePageUrl({ ...server, deployment: '' }, '42')).toBe(
      'https://wiki.company.ru/pages/viewpage.action?pageId=42',
    );
  });

  it('без адресов ссылки нет', () => {
    expect(confluencePageUrl({ ...cloud, baseUrl: '' }, '42')).toBe('');
    expect(confluencePageUrl(cloud, undefined)).toBe('');
  });
});

describe('linkRows', () => {
  it('пустая привязка не даёт строк', () => {
    expect(linkRows(undefined, sites)).toEqual([]);
    expect(linkRows({}, sites)).toEqual([]);
  });

  it('задача идёт первой и несёт заголовок вместе с ключом', () => {
    const rows = linkRows(
      { jiraIssueKey: 'QA-1', jiraIssueTitle: 'Оплата', jiraProjectKey: 'QA' },
      sites,
    );
    expect(rows[0]).toEqual({
      kind: 'jiraIssue',
      text: 'QA-1 · Оплата',
      url: 'https://site.atlassian.net/browse/QA-1',
    });
    expect(rows[1]?.kind).toBe('jiraProject');
  });

  it('страница без заголовка подписывается своим id', () => {
    const rows = linkRows({ confluencePageId: '77' }, { jira: cloud, confluence: server });
    expect(rows[0]?.text).toBe('77');
    // Ссылка страницы — на адрес Confluence, не Jira.
    expect(rows[0]?.url).toBe('https://wiki.company.ru/pages/viewpage.action?pageId=77');
  });

  it('репозиторий и заметка показываются без ссылок', () => {
    const rows = linkRows({ forgeRepo: 'org/app', note: 'требования тут' }, sites);
    expect(rows.map((row) => row.kind)).toEqual(['forgeRepo', 'note']);
    expect(rows.every((row) => row.url === '')).toBe(true);
  });
});
