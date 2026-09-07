import { describe, it, expect } from 'vitest';
import type { ConfluencePage, IntegrationLinks, JiraIssue } from '@agentdeck/contracts';
import {
  cleanLink,
  pickLink,
  withConfluencePage,
  withJiraIssue,
  withoutConfluencePage,
  withoutJiraIssue,
} from './linkDraft';

const links: IntegrationLinks = {
  project: { jiraProjectKey: 'QA' },
  groups: { gui: { jiraIssueKey: 'QA-7' } },
};

const issue: JiraIssue = {
  key: 'QA-9',
  summary: 'Оплата картой',
  status: 'В работе',
  type: 'Bug',
  url: 'https://site.atlassian.net/browse/QA-9',
};

const page: ConfluencePage = {
  id: '77',
  title: 'Требования к оплате',
  spaceKey: 'QA',
  url: 'https://site.atlassian.net/wiki/x/77',
};

describe('pickLink', () => {
  it('без группы отдаёт привязку самого проекта', () => {
    expect(pickLink(links, '')).toEqual({ jiraProjectKey: 'QA' });
  });

  it('с группой — её собственную привязку', () => {
    expect(pickLink(links, 'gui')).toEqual({ jiraIssueKey: 'QA-7' });
  });

  it('неизвестная группа и отсутствие ответа — пустая привязка, а не падение', () => {
    expect(pickLink(links, 'нет-такой')).toEqual({});
    expect(pickLink(undefined, 'gui')).toEqual({});
  });
});

describe('выбор объекта', () => {
  it('от задачи берутся ключ и заголовок, но не её адрес', () => {
    const next = withJiraIssue({ jiraProjectKey: 'QA' }, issue);
    expect(next).toEqual({
      jiraProjectKey: 'QA',
      jiraIssueKey: 'QA-9',
      jiraIssueTitle: 'Оплата картой',
    });
    expect(next).not.toHaveProperty('url');
  });

  it('от страницы — id и заголовок', () => {
    expect(withConfluencePage({}, page)).toEqual({
      confluencePageId: '77',
      confluencePageTitle: 'Требования к оплате',
    });
  });

  it('снятие уносит заголовок вместе с ключом', () => {
    expect(withoutJiraIssue(withJiraIssue({ note: 'тут' }, issue))).toEqual({ note: 'тут' });
    expect(withoutConfluencePage(withConfluencePage({ note: 'тут' }, page))).toEqual({
      note: 'тут',
    });
  });
});

describe('cleanLink', () => {
  it('пустые и пробельные поля не сохраняются', () => {
    expect(cleanLink({ jiraProjectKey: '  QA ', note: '   ', forgeRepo: '' })).toEqual({
      jiraProjectKey: 'QA',
    });
  });

  it('полностью пустая привязка остаётся пустым объектом', () => {
    expect(cleanLink({})).toEqual({});
  });
});
