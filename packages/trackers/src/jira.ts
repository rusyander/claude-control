import {
  TrackerError,
  trackerErrorCodeOf,
  trackerErrorOf,
  type TrackerResponse,
  type TrackerSend,
} from './index.ts';
import { callJson, jsonBody, parseJson } from './client.ts';
import type { TrackerSite } from './client.types.ts';
import { fromAdf, toAdf } from './adf.ts';
import type {
  RawJiraIssue,
  RawJiraIssueLink,
  RawJiraMyself,
  TrackerIssue,
  TrackerIssueLink,
  TrackerNewIssue,
  TrackerProject,
  TrackerSearch,
  TrackerTransition,
} from './jira.types.ts';

/**
 * Jira (этап 12, D15): чтение задач и три записи — завести дефект, дописать комментарий,
 * перевести статус. Один клиент на панель и входящие ядра: второго клиента Jira в дереве нет
 * (`one-jira-client.test.ts`). Удалений здесь нет и не будет.
 *
 * Пустые обязательные поля (текст поиска, проект, заголовок) судит вызывающий своим текстом до
 * вызова; сюда они доходят ошибкой программы, а не отказом трекера.
 */

/** Как отказ называет систему. */
export const JIRA_SYSTEM = 'Jira';

/** Поля карточки задачи панели. */
export const CARD_FIELDS = 'summary,status,issuetype,assignee,updated,description';

/** Поля входящих ядра: карточка + метки, приоритет, родитель (эпик), связи. */
export const RELATED_FIELDS = `${CARD_FIELDS},labels,priority,parent,issuelinks`;

/** Корень Jira REST для этого диалекта. */
export function jiraApi(site: TrackerSite): string {
  return `${site.baseUrl}/rest/api/${site.deployment === 'cloud' ? '3' : '2'}`;
}

/** Адрес задачи для человека. */
export function browseUrl(site: TrackerSite, key: string): string {
  return `${site.baseUrl}/browse/${key}`;
}

/**
 * Категория статуса — единственное, по чему можно судить о закрытости: названия статусов у
 * каждой команды свои, категорию Jira считает сама. Незнакомое значение честнее выбросить.
 */
function toCategory(key: string | undefined): TrackerIssue['statusCategory'] {
  if (key === 'done' || key === 'new' || key === 'indeterminate') return key;
  return undefined;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Связи задачи: ключ соседа с той стороны, где он есть; без ключа связь не читается. */
export function linksOf(raw: unknown): TrackerIssueLink[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawJiraIssueLink[]).flatMap((link): TrackerIssueLink[] => {
    const outward = nonEmpty(link.outwardIssue?.key);
    const inward = nonEmpty(link.inwardIssue?.key);
    const key = outward ?? inward;
    if (!key) return [];
    const relation = nonEmpty(outward ? link.type?.outward : link.type?.inward);
    return [{ key, ...(relation ? { relation } : {}), direction: outward ? 'outward' : 'inward' }];
  });
}

/** Задача из сырого ответа; `related` — дочитать метки, приоритет, родителя и связи. */
export function issueOf(site: TrackerSite, raw: RawJiraIssue, related = false): TrackerIssue {
  const fields = raw.fields ?? {};
  const issue: TrackerIssue = {
    key: raw.key,
    summary: fields.summary ?? '',
    status: fields.status?.name ?? '',
    statusCategory: toCategory(fields.status?.statusCategory?.key),
    type: fields.issuetype?.name ?? '',
    assignee: fields.assignee?.displayName ?? fields.assignee?.name,
    updatedAt: fields.updated,
    url: browseUrl(site, raw.key),
    description: fromAdf(fields.description),
  };
  if (!related) return issue;
  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((label): label is string => typeof label === 'string' && label !== '')
    : [];
  const parentKey = nonEmpty(fields.parent?.key);
  const parentSummary = nonEmpty(fields.parent?.fields?.summary);
  const priority = nonEmpty(fields.priority?.name);
  return {
    ...issue,
    labels,
    ...(priority ? { priority } : {}),
    ...(parentKey
      ? { parent: { key: parentKey, ...(parentSummary ? { summary: parentSummary } : {}) } }
      : {}),
    links: linksOf(fields.issuelinks),
  };
}

/** «Кто я»: ответ как есть — по коду проверка связи выбирает диалект, а не падает. */
export function myself(site: TrackerSite, send: TrackerSend): Promise<TrackerResponse> {
  return send({ url: `${jiraApi(site)}/myself`, method: 'GET', system: JIRA_SYSTEM });
}

/** Имя учётки из ответа `myself`; ни одного поля — нет имени (подпись выбирает вызывающий). */
export function accountOf(me: RawJiraMyself | null): string | undefined {
  return nonEmpty(me?.displayName) ?? nonEmpty(me?.name) ?? nonEmpty(me?.emailAddress);
}

function pickProject(project: TrackerProject): TrackerProject {
  return { id: String(project.id), key: project.key, name: project.name };
}

/**
 * Проекты. У облака список идёт постранично через `/project/search`, у своей установки — одним
 * массивом на `/project`. Разные ответы, один смысл.
 */
export async function listProjects(
  site: TrackerSite,
  send: TrackerSend,
): Promise<TrackerProject[]> {
  const api = jiraApi(site);
  if (site.deployment === 'cloud') {
    const page = await callJson<{ values?: TrackerProject[] } | null>(send, {
      url: `${api}/project/search?maxResults=100`,
      method: 'GET',
      system: JIRA_SYSTEM,
    });
    return (page?.values ?? []).map(pickProject);
  }
  const list = await callJson<TrackerProject[] | null>(send, {
    url: `${api}/project`,
    method: 'GET',
    system: JIRA_SYSTEM,
  });
  return (list ?? []).map(pickProject);
}

/** Строка в JQL: кавычки и обратные слэши внутри экранируются. */
export function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * JQL поиска: готовый JQL сильнее свободного текста; текст уходит как `text ~ "…"` — люди ищут
 * словами. Ни того, ни другого — пустая строка (вызывающий называет пустое поле сам).
 */
export function jqlOf(search: { q?: string; jql?: string }): string {
  const jql = search.jql?.trim();
  if (jql) return jql;
  const text = search.q?.trim();
  return text ? `text ~ ${quoteJql(text)}` : '';
}

/**
 * Поиск задач по JQL. JQL уходит закодированным в адрес: `&`, `=` и кавычки внутри запроса
 * иначе разрезали бы строку запроса.
 *
 * У облака классический `/search` объявлен устаревшим в пользу `/search/jql`; старые установки о
 * новом пути не знают. Поэтому облако пробует новый путь и, получив 404/410, повторяет на старом
 * — а не отвечает «ничего не нашли». Отказ по существу (401, 400 на кривом JQL) не повторяется.
 */
export async function searchIssues(
  site: TrackerSite,
  send: TrackerSend,
  search: TrackerSearch,
): Promise<TrackerIssue[]> {
  const jql = search.jql.trim();
  if (!jql) throw new RangeError('trackers: empty JQL');
  const limit = Math.min(Math.max(search.limit ?? 25, 1), 100);
  const api = jiraApi(site);
  const fields = search.related ? RELATED_FIELDS : CARD_FIELDS;
  const query = `jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=${fields}`;
  const paths =
    site.deployment === 'cloud'
      ? [`${api}/search/jql?${query}`, `${api}/search?${query}`]
      : [`${api}/search?${query}`];

  let failure: TrackerError | undefined;
  for (const url of paths) {
    const response = await send({ url, method: 'GET', system: JIRA_SYSTEM });
    const code = trackerErrorCodeOf(response.status);
    if (code === null) {
      const page = parseJson<{ issues?: RawJiraIssue[] } | null>(JIRA_SYSTEM, response);
      return (page?.issues ?? []).map((issue) => issueOf(site, issue, search.related));
    }
    failure = trackerErrorOf(code, JIRA_SYSTEM, response);
    if (response.status !== 404 && response.status !== 410) break;
  }
  throw failure!;
}

/**
 * Задача как есть, с выбранной строкой запроса (`fields=…`, `expand=names`): снимок приёма
 * ядра читает поля, которых нет у карточки. Пустое тело — `null`.
 */
export function readIssueRaw(
  site: TrackerSite,
  send: TrackerSend,
  key: string,
  query: string,
): Promise<unknown> {
  return callJson<unknown>(send, {
    url: `${jiraApi(site)}/issue/${encodeURIComponent(key)}?${query}`,
    method: 'GET',
    system: JIRA_SYSTEM,
  });
}

export async function readIssue(
  site: TrackerSite,
  send: TrackerSend,
  key: string,
  options: { related?: boolean } = {},
): Promise<TrackerIssue> {
  const fields = options.related ? RELATED_FIELDS : CARD_FIELDS;
  const raw = (await readIssueRaw(site, send, key, `fields=${fields}`)) as RawJiraIssue | null;
  if (raw === null || typeof raw !== 'object') throw new TrackerError('bad-response', JIRA_SYSTEM);
  return issueOf(site, raw, options.related);
}

/**
 * Завести задачу. Описание уходит в том виде, который понимает диалект: облако ждёт документ
 * ADF, своя установка — обычный текст с вики-разметкой.
 */
export async function createIssue(
  site: TrackerSite,
  send: TrackerSend,
  draft: TrackerNewIssue,
): Promise<TrackerIssue> {
  const created = await callJson<{ key: string }>(send, {
    url: `${jiraApi(site)}/issue`,
    method: 'POST',
    system: JIRA_SYSTEM,
    ...jsonBody({
      fields: {
        project: { key: draft.projectKey.trim() },
        summary: draft.summary.trim(),
        issuetype: { name: draft.issueType?.trim() || 'Bug' },
        description: site.deployment === 'cloud' ? toAdf(draft.description) : draft.description,
        ...(draft.labels?.length ? { labels: draft.labels } : {}),
        ...(draft.priority?.trim() ? { priority: { name: draft.priority.trim() } } : {}),
      },
    }),
  });
  return readIssue(site, send, created.key);
}

/** Комментарий к задаче: облаку — документ ADF, своей установке — текст. */
export async function commentIssue(
  site: TrackerSite,
  send: TrackerSend,
  key: string,
  body: string,
): Promise<void> {
  await callJson<unknown>(send, {
    url: `${jiraApi(site)}/issue/${encodeURIComponent(key)}/comment`,
    method: 'POST',
    system: JIRA_SYSTEM,
    ...jsonBody({ body: site.deployment === 'cloud' ? toAdf(body) : body }),
  });
}

export async function listTransitions(
  site: TrackerSite,
  send: TrackerSend,
  key: string,
): Promise<TrackerTransition[]> {
  const payload = await callJson<{
    transitions?: { id: string; name: string; to?: { name?: string } }[];
  } | null>(send, {
    url: `${jiraApi(site)}/issue/${encodeURIComponent(key)}/transitions`,
    method: 'GET',
    system: JIRA_SYSTEM,
  });
  return (payload?.transitions ?? []).map((item) => ({
    id: String(item.id),
    name: item.name,
    ...(item.to?.name ? { to: item.to.name } : {}),
  }));
}

/** Перевести задачу по рабочему процессу (в панели — кнопкой человека). */
export async function applyTransition(
  site: TrackerSite,
  send: TrackerSend,
  key: string,
  transitionId: string,
): Promise<void> {
  await callJson<unknown>(send, {
    url: `${jiraApi(site)}/issue/${encodeURIComponent(key)}/transitions`,
    method: 'POST',
    system: JIRA_SYSTEM,
    ...jsonBody({ transition: { id: transitionId.trim() } }),
  });
}
