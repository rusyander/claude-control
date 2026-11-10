import type { JiraIssue, JiraProject, JiraTransition } from '@agentdeck/contracts';
import * as tracker from '@agentdeck/trackers/jira';
import type { TrackerIssue } from '@agentdeck/trackers/jira.types';
import { invalidField } from '../errors.ts';
import type { AtlassianAccess } from './client.ts';
import { viaTracker } from './tracker-port.ts';

/**
 * Jira панели: чтение задач и три записи, ради которых всё затевалось, — завести дефект,
 * дописать комментарий, перевести статус. Запросы, адреса и разбор — общий клиент
 * `@agentdeck/trackers` (этап 12, D15: второго клиента Jira в дереве нет); здесь — проверка
 * полей формы своим текстом и отказ трекера словами панели (`viaTracker`).
 *
 * Удалений здесь нет и не будет: панель не сносит чужие задачи ни при каких
 * условиях, даже по просьбе агента.
 */

/** Карточка задачи панели — ровно поля контракта, без меток и связей входящих ядра. */
function toIssue(issue: TrackerIssue): JiraIssue {
  return {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    statusCategory: issue.statusCategory,
    type: issue.type,
    assignee: issue.assignee,
    updatedAt: issue.updatedAt,
    url: issue.url,
    description: issue.description,
  };
}

/** Проекты: облако — постранично `/project/search`, своя установка — массивом `/project`. */
export function listProjects(access: AtlassianAccess): Promise<JiraProject[]> {
  return viaTracker(access, (site, send) => tracker.listProjects(site, send));
}

export interface IssueSearch {
  /** Свободный текст: превращается в JQL `text ~ "…"`. */
  q?: string;
  /** Готовый JQL — сильнее свободного текста, если задан. */
  jql?: string;
  limit?: number;
}

/**
 * Поиск задач. Свободный текст уходит как `text ~ "…"`: люди ищут словами, а не JQL; кто умеет
 * JQL, присылает его и получает его же. Облако пробует `/search/jql` и на 404/410 повторяет на
 * классическом `/search` (это делает клиент).
 */
export async function searchIssues(
  access: AtlassianAccess,
  search: IssueSearch,
): Promise<JiraIssue[]> {
  const jql = tracker.jqlOf(search);
  if (!jql)
    throw invalidField('q', 'нужен текст поиска или JQL', 'request-search-or-jql-required', {
      field: 'q',
    });
  const issues = await viaTracker(access, (site, send) =>
    tracker.searchIssues(site, send, { jql, limit: search.limit }),
  );
  return issues.map(toIssue);
}

export async function readIssue(access: AtlassianAccess, key: string): Promise<JiraIssue> {
  return toIssue(await viaTracker(access, (site, send) => tracker.readIssue(site, send, key)));
}

export interface NewIssue {
  projectKey: string;
  summary: string;
  description: string;
  /** Тип задачи; пусто — «Bug»: панель заводит именно дефекты. */
  issueType?: string;
  labels?: string[];
  /** Имя приоритета, как его знает эта установка (`listPriorities`); пусто — по умолчанию Jira. */
  priority?: string;
}

/** Завести задачу: облаку описание уходит документом ADF, своей установке — текстом. */
export async function createIssue(access: AtlassianAccess, draft: NewIssue): Promise<JiraIssue> {
  if (!draft.projectKey.trim())
    throw invalidField('projectKey', 'не указан проект Jira', 'request-jira-project-missing', {
      field: 'projectKey',
    });
  if (!draft.summary.trim())
    throw invalidField('summary', 'не указан заголовок задачи', 'request-issue-title-missing', {
      field: 'summary',
    });
  return toIssue(await viaTracker(access, (site, send) => tracker.createIssue(site, send, draft)));
}

/** Комментарий к задаче — вторая из трёх разрешённых агенту записей. */
export async function commentIssue(
  access: AtlassianAccess,
  key: string,
  body: string,
): Promise<void> {
  if (!body.trim())
    throw invalidField('body', 'пустой комментарий', 'request-comment-empty', { field: 'body' });
  await viaTracker(access, (site, send) => tracker.commentIssue(site, send, key, body));
}

export function listTransitions(access: AtlassianAccess, key: string): Promise<JiraTransition[]> {
  return viaTracker(access, (site, send) => tracker.listTransitions(site, send, key));
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
  if (!transitionId.trim())
    throw invalidField('id', 'не указан переход', 'request-transition-missing', { field: 'id' });
  await viaTracker(access, (site, send) => tracker.applyTransition(site, send, key, transitionId));
}
