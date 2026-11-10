/**
 * GitLab v4 — чтения входящих ядра (этап 12, D16): задачи, назначенные учётке, с метками и
 * связями. Формы — как у GitLab: `references.full` даёт путь проекта, связь двусторонняя, метки
 * в `labels=` — все сразу (И), страницы новые первыми. Списки MR входящих — в `gitlab.mjs`.
 */

import { pageOf } from './paging.mjs';

const iso = (ms) => new Date(ms).toISOString();

const ok = (body) => ({ status: 200, body });
const notFound = (what) => ({ status: 404, body: { message: `404 ${what} Not Found` } });

function person(state, id) {
  const u = state.user(id);
  return { id: u.id, username: u.username, name: u.username };
}

export function gitlabIssue(state, baseUrl, issue) {
  const project = state.project(issue.projectId);
  const assignees = issue.assigneeIds.map((id) => person(state, id));
  return {
    id: issue.id,
    iid: issue.iid,
    project_id: issue.projectId,
    title: issue.title,
    description: issue.body,
    state: issue.state,
    labels: [...issue.labels],
    assignees,
    assignee: assignees[0] ?? null,
    author: person(state, issue.authorId),
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    web_url: `${baseUrl}/${project.path}/-/issues/${issue.iid}`,
    references: {
      short: `#${issue.iid}`,
      relative: `#${issue.iid}`,
      full: `${project.path}#${issue.iid}`,
    },
    epic: issue.epic
      ? {
          id: issue.epic.id,
          iid: issue.epic.iid,
          title: issue.epic.title ?? `Epic ${issue.epic.iid}`,
          group_id: issue.epic.groupId,
        }
      : null,
    epic_iid: issue.epic ? issue.epic.iid : null,
  };
}

/** `labels=a,b` у GitLab — задача несёт КАЖДУЮ из меток; пусто — без условия. */
export function hasLabels(record, query) {
  const wanted = (query.get('labels') ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  return wanted.every((l) => record.labels.includes(l));
}

/** Состояние списка: `opened` по умолчанию — нет; GitLab без `state` отдаёт все. */
function stateMatches(record, query, map = (s) => s) {
  const asked = query.get('state');
  return !asked || asked === 'all' || map(record.state) === asked;
}

/** Порядок GitLab по умолчанию — `created_at` по убыванию; `sort=asc` переворачивает. */
export function newestFirst(list, query) {
  const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return query.get('sort') === 'asc' ? sorted.reverse() : sorted;
}

/** `GET /issues` — задачи по всему сайту; `scope` по умолчанию у GitLab — `created_by_me`. */
export function globalIssues(ctx) {
  const { state, query, actor, baseUrl } = ctx;
  const scope = query.get('scope') ?? 'created_by_me';
  const assignee = query.get('assignee_username');
  const found = state.issues
    .filter((i) => scope !== 'assigned_to_me' || i.assigneeIds.includes(actor.id))
    .filter((i) => scope !== 'created_by_me' || i.authorId === actor.id)
    .filter((i) => !assignee || i.assigneeIds.some((id) => state.user(id).username === assignee))
    .filter((i) => stateMatches(i, query))
    .filter((i) => hasLabels(i, query));
  return ok(
    pageOf(newestFirst(found, query), query, 20).map((i) => gitlabIssue(state, baseUrl, i)),
  );
}

function linkedOf(state, issue) {
  const side = (ref) => ref.projectId === issue.projectId && ref.iid === issue.iid;
  return state.issueLinks.flatMap((link) => {
    const other = side(link.source) ? link.target : side(link.target) ? link.source : null;
    if (!other) return [];
    const found = state.issues.find((i) => i.projectId === other.projectId && i.iid === other.iid);
    return found ? [{ link, issue: found }] : [];
  });
}

/** `/projects/:id/issues[/:iid[/links]]`; `undefined` — пути нет в подмножестве. */
export function issueRoutes(ctx, project, rest) {
  const { state, method, query, baseUrl } = ctx;
  if (method !== 'GET') return undefined;
  const own = state.issues.filter((i) => i.projectId === project.id);
  if (rest.length === 0) {
    const found = own.filter((i) => stateMatches(i, query)).filter((i) => hasLabels(i, query));
    return ok(
      pageOf(newestFirst(found, query), query, 20).map((i) => gitlabIssue(state, baseUrl, i)),
    );
  }
  const issue = own.find((i) => String(i.iid) === rest[0]);
  if (!issue) return notFound('Issue');
  if (rest.length === 1) return ok(gitlabIssue(state, baseUrl, issue));
  if (rest[1] === 'links' && rest.length === 2) {
    return ok(
      linkedOf(state, issue).map(({ link, issue: other }) => ({
        ...gitlabIssue(state, baseUrl, other),
        issue_link_id: link.id,
        link_type: 'relates_to',
      })),
    );
  }
  return undefined;
}
