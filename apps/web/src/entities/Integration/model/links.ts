import { trimSlash } from './trimSlash';

/** Ссылка на задачу Jira. Нет адреса или ключа — ссылки нет, и это не ошибка. */
export function jiraIssueUrl(baseUrl: string, key: string | undefined): string {
  if (!baseUrl || !key) return '';
  return `${trimSlash(baseUrl)}/browse/${encodeURIComponent(key)}`;
}
