import { describe, it, expect } from 'vitest';
import type { AtlassianSettings } from '@agentdeck/contracts';
import { confluencePageUrl, jiraIssueUrl, linkRows } from './links';

const cloud: AtlassianSettings = {
  enabled: true,
  baseUrl: 'https://site.atlassian.net/',
  email: 'qa@example.com',
  deployment: 'cloud',
  confluenceUrl: '',
};

const server: AtlassianSettings = {
  enabled: true,
  baseUrl: 'https://jira.company.ru',
  email: '',
  deployment: 'server',
  confluenceUrl: '',
};

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

  it('своя установка — в корне хоста', () => {
    expect(confluencePageUrl(server, '42')).toBe(
      'https://jira.company.ru/pages/viewpage.action?pageId=42',
    );
  });

  it('отдельный адрес Confluence отменяет догадки о корне', () => {
    const own = { ...cloud, confluenceUrl: 'https://wiki.company.ru/' };
    expect(confluencePageUrl(own, '42')).toBe(
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
    expect(linkRows(undefined, cloud)).toEqual([]);
    expect(linkRows({}, cloud)).toEqual([]);
  });

  it('задача идёт первой и несёт заголовок вместе с ключом', () => {
    const rows = linkRows(
      { jiraIssueKey: 'QA-1', jiraIssueTitle: 'Оплата', jiraProjectKey: 'QA' },
      cloud,
    );
    expect(rows[0]).toEqual({
      kind: 'jiraIssue',
      text: 'QA-1 · Оплата',
      url: 'https://site.atlassian.net/browse/QA-1',
    });
    expect(rows[1]?.kind).toBe('jiraProject');
  });

  it('страница без заголовка подписывается своим id', () => {
    const rows = linkRows({ confluencePageId: '77' }, cloud);
    expect(rows[0]?.text).toBe('77');
    expect(rows[0]?.url).toContain('pageId=77');
  });

  it('репозиторий и заметка показываются без ссылок', () => {
    const rows = linkRows({ forgeRepo: 'org/app', note: 'требования тут' }, cloud);
    expect(rows.map((row) => row.kind)).toEqual(['forgeRepo', 'note']);
    expect(rows.every((row) => row.url === '')).toBe(true);
  });
});
