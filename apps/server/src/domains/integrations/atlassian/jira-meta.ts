import { call, jiraApi, type AtlassianAccess } from './client.ts';

/**
 * Справочники Jira для заведения задач разом из хаба («Разобрать…»): какие
 * типы задач есть у проекта и какие приоритеты знает установка. Оба — чтение;
 * пишет только `createIssue`.
 *
 * `/project/{key}` отдаёт типы задач и у облака, и у своей установки (у
 * `createmeta` формы разошлись между версиями); приоритеты — `/priority` у обоих.
 */

interface RawProject {
  issueTypes?: { name?: string; subtask?: boolean }[];
}

/** Типы задач проекта без подзадач: подзадачу без родителя не завести. */
export async function listIssueTypes(
  access: AtlassianAccess,
  projectKey: string,
): Promise<string[]> {
  const project = await call<RawProject>(access, {
    url: `${jiraApi(access)}/project/${encodeURIComponent(projectKey)}`,
    system: 'Jira',
  });
  return (project.issueTypes ?? [])
    .filter((type) => !type.subtask && typeof type.name === 'string' && type.name.trim())
    .map((type) => String(type.name).trim());
}

/** Имена приоритетов установки в её порядке (обычно от высшего к низшему). */
export async function listPriorities(access: AtlassianAccess): Promise<string[]> {
  const list = await call<{ name?: string }[]>(access, {
    url: `${jiraApi(access)}/priority`,
    system: 'Jira',
  });
  return (Array.isArray(list) ? list : [])
    .map((item) => (typeof item.name === 'string' ? item.name.trim() : ''))
    .filter(Boolean);
}
