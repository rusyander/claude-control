import type { AtlassianSettings, IntegrationLink } from '@agentdeck/contracts';

/**
 * Адреса привязанных объектов Atlassian.
 *
 * В привязке лежат ключ задачи и id страницы, а не ссылки: ключ переживает
 * переезд сайта, ссылка — нет. Собираем адрес здесь, из настроек коннектора,
 * чтобы на телефоне и в панели он получался одинаковым.
 *
 * Формула у облака и своей установки общая, разъезжается только корень
 * Confluence: в облаке он живёт под `/wiki`, у Server/DC — в корне хоста.
 * `viewpage.action?pageId=` понимают оба — это единственный адрес страницы,
 * который можно собрать, зная только её id.
 */

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

/** Ссылка на задачу Jira. Нет адреса или ключа — ссылки нет, и это не ошибка. */
export function jiraIssueUrl(baseUrl: string, key: string | undefined): string {
  if (!baseUrl || !key) return '';
  return `${trimSlash(baseUrl)}/browse/${encodeURIComponent(key)}`;
}

/** Ссылка на страницу Confluence по её id. */
export function confluencePageUrl(
  atlassian: AtlassianSettings,
  pageId: string | undefined,
): string {
  if (!pageId) return '';
  const own = trimSlash(atlassian.confluenceUrl);
  const base = trimSlash(atlassian.baseUrl);
  if (!own && !base) return '';
  // Свой адрес Confluence задан — он уже указывает на корень, `/wiki` не нужен.
  const root = own || (atlassian.deployment === 'server' ? base : `${base}/wiki`);
  return `${root}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

/** Что показывать строкой: подпись объекта и адрес, если его удалось собрать. */
export interface LinkRow {
  kind: 'jiraIssue' | 'jiraProject' | 'confluencePage' | 'forgeRepo' | 'note';
  text: string;
  url: string;
}

/**
 * Привязка, разложенная в строки для показа. Порядок — от того, что человек
 * ищет чаще: задача, требования, куда заводить дефекты, свой репозиторий.
 */
export function linkRows(
  link: IntegrationLink | undefined,
  atlassian: AtlassianSettings,
): LinkRow[] {
  if (!link) return [];
  const rows: LinkRow[] = [];

  if (link.jiraIssueKey) {
    const title = link.jiraIssueTitle ? ` · ${link.jiraIssueTitle}` : '';
    rows.push({
      kind: 'jiraIssue',
      text: `${link.jiraIssueKey}${title}`,
      url: jiraIssueUrl(atlassian.baseUrl, link.jiraIssueKey),
    });
  }
  if (link.confluencePageId) {
    rows.push({
      kind: 'confluencePage',
      text: link.confluencePageTitle || link.confluencePageId,
      url: confluencePageUrl(atlassian, link.confluencePageId),
    });
  }
  if (link.jiraProjectKey) {
    rows.push({ kind: 'jiraProject', text: link.jiraProjectKey, url: '' });
  }
  if (link.forgeRepo) rows.push({ kind: 'forgeRepo', text: link.forgeRepo, url: '' });
  if (link.note) rows.push({ kind: 'note', text: link.note, url: '' });

  return rows;
}
