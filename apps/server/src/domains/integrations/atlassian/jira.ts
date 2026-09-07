import type { JiraIssue, JiraProject, JiraTransition } from '@agentdeck/contracts';
import { invalidField, unreachable } from '../errors.ts';
import { describeFailure, parseJson, type OutboundResponse } from '../http.ts';
import { call, jiraApi, raw, type AtlassianAccess } from './client.ts';
import { fromAdf, toAdf } from './adf.ts';

/**
 * Jira: чтение задач и три записи, ради которых всё затевалось, — завести
 * дефект, дописать комментарий, перевести статус.
 *
 * Удалений здесь нет и не будет: панель не сносит чужие задачи ни при каких
 * условиях, даже по просьбе агента.
 */

interface RawIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    assignee?: { displayName?: string; name?: string };
    updated?: string;
    description?: unknown;
  };
}

/** Поля, которые панель показывает в списке и в карточке задачи. */
const ISSUE_FIELDS = 'summary,status,issuetype,assignee,updated,description';

function toIssue(access: AtlassianAccess, issue: RawIssue): JiraIssue {
  const fields = issue.fields ?? {};
  return {
    key: issue.key,
    summary: fields.summary ?? '',
    status: fields.status?.name ?? '',
    type: fields.issuetype?.name ?? '',
    assignee: fields.assignee?.displayName ?? fields.assignee?.name,
    updatedAt: fields.updated,
    url: `${access.baseUrl}/browse/${issue.key}`,
    description: fromAdf(fields.description),
  };
}

/**
 * Проекты. У облака список идёт постранично через `/project/search`, у своей
 * установки — одним массивом на `/project`. Разные ответы, один смысл.
 */
export async function listProjects(access: AtlassianAccess): Promise<JiraProject[]> {
  const api = jiraApi(access);
  if (access.deployment === 'cloud') {
    const page = await call<{ values?: JiraProject[] }>(access, {
      url: `${api}/project/search?maxResults=100`,
      system: 'Jira',
    });
    return (page.values ?? []).map(pickProject);
  }
  const list = await call<JiraProject[]>(access, { url: `${api}/project`, system: 'Jira' });
  return (list ?? []).map(pickProject);
}

function pickProject(project: JiraProject): JiraProject {
  return { id: String(project.id), key: project.key, name: project.name };
}

export interface IssueSearch {
  /** Свободный текст: превращается в JQL `text ~ "…"`. */
  q?: string;
  /** Готовый JQL — сильнее свободного текста, если задан. */
  jql?: string;
  limit?: number;
}

/**
 * Поиск задач.
 *
 * Свободный текст экранируется и уходит как `text ~ "…"`: люди ищут словами, а
 * не JQL, и заставлять их писать запрос ради одной кнопки «привязать задачу» —
 * лишний барьер. Кто умеет JQL, присылает его и получает его же.
 *
 * У облака классический `/search` объявлен устаревшим в пользу `/search/jql`;
 * старые установки о новом пути не знают. Поэтому облако пробует новый путь и,
 * получив 404/410, честно повторяет на старом — а не отвечает «ничего не нашли».
 */
export async function searchIssues(
  access: AtlassianAccess,
  search: IssueSearch,
): Promise<JiraIssue[]> {
  const jql = search.jql?.trim() || (search.q?.trim() ? `text ~ ${quote(search.q.trim())}` : '');
  if (!jql) throw invalidField('q', 'нужен текст поиска или JQL');

  const limit = Math.min(Math.max(search.limit ?? 25, 1), 100);
  const api = jiraApi(access);
  const query = `jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=${ISSUE_FIELDS}`;
  const paths =
    access.deployment === 'cloud'
      ? [`${api}/search/jql?${query}`, `${api}/search?${query}`]
      : [`${api}/search?${query}`];

  let last: OutboundResponse | undefined;
  for (const url of paths) {
    const response = await raw(access, { url, system: 'Jira' });
    if (response.ok) {
      const page = parseJson<{ issues?: RawIssue[] }>('Jira', response);
      return (page.issues ?? []).map((issue) => toIssue(access, issue));
    }
    last = response;
    // «Нет такой ручки» — повод попробовать соседнюю; отказ по существу (401,
    // 400 на кривом JQL) повторять бессмысленно, его надо показать человеку.
    if (response.status !== 404 && response.status !== 410) break;
  }

  throw unreachable(describeFailure('Jira', last!), last!.text.slice(0, 500));
}

export async function readIssue(access: AtlassianAccess, key: string): Promise<JiraIssue> {
  const issue = await call<RawIssue>(access, {
    url: `${jiraApi(access)}/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
    system: 'Jira',
  });
  return toIssue(access, issue);
}

export interface NewIssue {
  projectKey: string;
  summary: string;
  description: string;
  /** Тип задачи; пусто — «Bug»: панель заводит именно дефекты. */
  issueType?: string;
  labels?: string[];
}

/**
 * Завести задачу. Описание уходит в том виде, который понимает диалект: облако
 * ждёт документ ADF, своя установка — обычный текст с вики-разметкой.
 */
export async function createIssue(access: AtlassianAccess, draft: NewIssue): Promise<JiraIssue> {
  if (!draft.projectKey.trim()) throw invalidField('projectKey', 'не указан проект Jira');
  if (!draft.summary.trim()) throw invalidField('summary', 'не указан заголовок задачи');

  const created = await call<{ key: string }>(access, {
    url: `${jiraApi(access)}/issue`,
    method: 'POST',
    system: 'Jira',
    body: {
      fields: {
        project: { key: draft.projectKey.trim() },
        summary: draft.summary.trim(),
        issuetype: { name: draft.issueType?.trim() || 'Bug' },
        description: access.deployment === 'cloud' ? toAdf(draft.description) : draft.description,
        ...(draft.labels?.length ? { labels: draft.labels } : {}),
      },
    },
  });
  return readIssue(access, created.key);
}

/** Комментарий к задаче — вторая из трёх разрешённых агенту записей. */
export async function commentIssue(
  access: AtlassianAccess,
  key: string,
  body: string,
): Promise<void> {
  if (!body.trim()) throw invalidField('body', 'пустой комментарий');
  await call<unknown>(access, {
    url: `${jiraApi(access)}/issue/${encodeURIComponent(key)}/comment`,
    method: 'POST',
    system: 'Jira',
    body: { body: access.deployment === 'cloud' ? toAdf(body) : body },
  });
}

export async function listTransitions(
  access: AtlassianAccess,
  key: string,
): Promise<JiraTransition[]> {
  const payload = await call<{ transitions?: { id: string; name: string }[] }>(access, {
    url: `${jiraApi(access)}/issue/${encodeURIComponent(key)}/transitions`,
    system: 'Jira',
  });
  return (payload.transitions ?? []).map((item) => ({ id: String(item.id), name: item.name }));
}

/**
 * Перевести задачу по рабочему процессу. Делает это ЧЕЛОВЕК кнопкой в панели:
 * агенту переход не разрешён — он не знает, что означает «Готово» у этой команды.
 */
export async function applyTransition(
  access: AtlassianAccess,
  key: string,
  transitionId: string,
): Promise<void> {
  if (!transitionId.trim()) throw invalidField('id', 'не указан переход');
  await call<unknown>(access, {
    url: `${jiraApi(access)}/issue/${encodeURIComponent(key)}/transitions`,
    method: 'POST',
    system: 'Jira',
    body: { transition: { id: transitionId.trim() } },
  });
}

/** Строка в JQL: кавычки и обратные слэши внутри — экранируются. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
