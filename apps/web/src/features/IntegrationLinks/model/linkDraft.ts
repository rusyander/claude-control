import type {
  ConfluencePage,
  IntegrationLink,
  IntegrationLinks,
  JiraIssue,
} from '@agentdeck/contracts';

/**
 * Черновик привязки: что человек выбрал в поиске и что из этого уйдёт на сервер.
 *
 * Из найденного объекта берём ключ и заголовок, но НЕ ссылку: ключ переживает
 * переезд сайта, а адрес собирается из настроек коннектора. Заголовок хранится
 * только чтобы строка привязки читалась без похода в Jira — сам по себе он ни
 * на что не влияет и спокойно устаревает.
 */

/** Привязка нужной области: сам проект или одна из его групп тестов. */
export function pickLink(links: IntegrationLinks | undefined, groupId: string): IntegrationLink {
  if (!links) return {};
  if (!groupId) return links.project ?? {};
  return links.groups?.[groupId] ?? {};
}

export function withJiraIssue(link: IntegrationLink, issue: JiraIssue): IntegrationLink {
  return { ...link, jiraIssueKey: issue.key, jiraIssueTitle: issue.summary };
}

export function withConfluencePage(link: IntegrationLink, page: ConfluencePage): IntegrationLink {
  return { ...link, confluencePageId: page.id, confluencePageTitle: page.title };
}

/**
 * Снять один выбранный объект. Заголовок уходит вместе с ключом: заголовок без
 * ключа — это строка, по которой уже никуда не перейти.
 */
export function withoutJiraIssue(link: IntegrationLink): IntegrationLink {
  const { jiraIssueKey: _key, jiraIssueTitle: _title, ...rest } = link;
  return rest;
}

export function withoutConfluencePage(link: IntegrationLink): IntegrationLink {
  const { confluencePageId: _id, confluencePageTitle: _title, ...rest } = link;
  return rest;
}

/**
 * Тело для сохранения: пустые строки выбрасываются, чтобы «стёр поле» и
 * «никогда не заполнял» лежали на диске одинаково, а не двумя разными формами
 * одного и того же.
 */
export function cleanLink(link: IntegrationLink): IntegrationLink {
  const result: IntegrationLink = {};
  for (const [key, value] of Object.entries(link)) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) (result as Record<string, string>)[key] = text;
  }
  return result;
}
