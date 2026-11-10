/**
 * Память заглушки трекера: учётки, проекты, задачи с метками, родителем и связями, комментарии.
 * Засев по умолчанию — маленький проект `PROJ` (эпик, дефект с меткой и связью, задача): его
 * хватает входящим ядра и экранам Jira панели, а свои задачи тест кладёт `issues` / `upsertIssue`.
 * Значения доступа выдуманные и в след не попадают — только имя учётки.
 */
import { createHash } from 'node:crypto';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Выдуманное значение доступа учётки: стабильно по имени, ни на что настоящее не похоже. */
export const stubTrackerToken = (name) => `stub-tracker-${name}-${sha256(name).slice(0, 12)}`;

export const DEFAULT_USERS = Object.freeze([
  Object.freeze({
    name: 'agent',
    email: 'agent@tracker.example.com',
    displayName: 'Stub Agent',
    token: stubTrackerToken('agent'),
  }),
  Object.freeze({
    name: 'owner',
    email: 'owner@tracker.example.com',
    displayName: 'Stub Owner',
    token: stubTrackerToken('owner'),
  }),
]);

export const DEFAULT_PROJECTS = Object.freeze([
  Object.freeze({ id: '10000', key: 'PROJ', name: 'Stub project' }),
]);

/** Поле критериев приёмки: снимок приёма находит его по имени из `expand=names`. */
export const ACCEPTANCE_FIELD_ID = 'customfield_10100';
export const ACCEPTANCE_FIELD_NAME = 'Acceptance Criteria';

/** Рабочий процесс заглушки: переход → статус и его категория. */
export const WORKFLOW = Object.freeze([
  Object.freeze({ id: '11', name: 'To Do', status: 'To Do', category: 'new' }),
  Object.freeze({ id: '21', name: 'Start work', status: 'In Progress', category: 'indeterminate' }),
  Object.freeze({ id: '31', name: 'Done', status: 'Done', category: 'done' }),
]);

export const DEFAULT_ISSUES = Object.freeze([
  Object.freeze({ key: 'PROJ-1', summary: 'Login epic', type: 'Epic' }),
  Object.freeze({
    key: 'PROJ-2',
    summary: 'Login button does nothing',
    description: 'Steps:\nopen the login page\npress the button',
    type: 'Bug',
    labels: ['agentdeck'],
    assignee: 'agent',
    priority: 'High',
    parent: 'PROJ-1',
    links: [{ type: 'Blocks', key: 'PROJ-3', direction: 'outward' }],
    acceptance: ['the button opens the session', 'an error is shown on a wrong password'],
  }),
  Object.freeze({ key: 'PROJ-3', summary: 'Session storage', type: 'Task', assignee: 'owner' }),
]);

/** Слова связи Jira по имени типа: с какой стороны как она читается. */
const LINK_WORDS = {
  Blocks: { outward: 'blocks', inward: 'is blocked by' },
  Relates: { outward: 'relates to', inward: 'relates to' },
  Duplicate: { outward: 'duplicates', inward: 'is duplicated by' },
};

function isoAt(ms) {
  return new Date(ms).toISOString().replace('Z', '+0000');
}

export function createState(options = {}) {
  const now = options.now ?? Date.now;
  const users = (options.users ?? DEFAULT_USERS).map((u) => ({
    ...u,
    token: u.token ?? stubTrackerToken(u.name),
    displayName: u.displayName ?? u.name,
  }));
  const projects = (options.projects ?? DEFAULT_PROJECTS).map((p) => ({ ...p }));
  const issues = new Map();
  let nextIssueId = 20000;
  let nextCommentId = 1;

  function projectOf(key) {
    return key.replace(/-\d+$/, '');
  }

  /** Засев или правка задачи: правка двигает `updated`, неназванные поля остаются. */
  function upsertIssue(seed) {
    if (typeof seed?.key !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/.test(seed.key))
      throw new TypeError(`stub-tracker: bad issue key «${seed?.key}»`);
    const before = issues.get(seed.key);
    const status = seed.status ?? before?.status ?? 'To Do';
    const flow = WORKFLOW.find((w) => w.status === status);
    const issue = {
      id: before?.id ?? String(nextIssueId++),
      key: seed.key,
      project: projectOf(seed.key),
      summary: seed.summary ?? before?.summary ?? '',
      description: seed.description ?? before?.description ?? '',
      status,
      statusCategory: seed.statusCategory ?? flow?.category ?? before?.statusCategory ?? 'new',
      type: seed.type ?? before?.type ?? 'Task',
      assignee: seed.assignee === undefined ? (before?.assignee ?? null) : seed.assignee,
      labels: [...(seed.labels ?? before?.labels ?? [])],
      priority: seed.priority ?? before?.priority ?? 'Medium',
      parent: seed.parent === undefined ? (before?.parent ?? null) : seed.parent,
      links: (seed.links ?? before?.links ?? []).map((l) => ({ ...l })),
      acceptance: [...(seed.acceptance ?? before?.acceptance ?? [])],
      comments: before?.comments ?? [],
      created: before?.created ?? now(),
      updated: now(),
    };
    issues.set(issue.key, issue);
    return issue;
  }

  for (const seed of options.issues ?? DEFAULT_ISSUES) upsertIssue(seed);

  function nextKey(projectKey) {
    let max = 0;
    for (const issue of issues.values())
      if (issue.project === projectKey) max = Math.max(max, Number(issue.key.split('-').pop()));
    return `${projectKey}-${max + 1}`;
  }

  function addComment(issue, author, body, text) {
    const comment = {
      id: String(nextCommentId++),
      author: author.name,
      body,
      text,
      created: now(),
    };
    issue.comments.push(comment);
    issue.updated = now();
    return comment;
  }

  function userByName(name) {
    return users.find((u) => u.name === name) ?? null;
  }

  function linkWords(type) {
    return LINK_WORDS[type] ?? { outward: type.toLowerCase(), inward: type.toLowerCase() };
  }

  function snapshot() {
    return {
      users: users.map(({ name, email, displayName }) => ({ name, email, displayName })),
      projects: projects.map((p) => ({ ...p })),
      issues: [...issues.values()].map((i) => ({
        ...i,
        labels: [...i.labels],
        links: i.links.map((l) => ({ ...l })),
        acceptance: [...i.acceptance],
        comments: i.comments.map((c) => ({ ...c })),
      })),
    };
  }

  return {
    now,
    users,
    projects,
    issues,
    upsertIssue,
    nextKey,
    addComment,
    userByName,
    linkWords,
    isoAt,
    snapshot,
  };
}
