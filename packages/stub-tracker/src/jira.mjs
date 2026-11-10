/**
 * Ручки Jira заглушки — подмножество, которым пользуются клиент `@agentdeck/trackers`, экраны Jira
 * панели и снимок приёма: `myself`, проекты, поиск (`/search/jql` облака и классический
 * `/search`), задача (`fields`, `expand=names`, родитель, связи, критерии), создание, комментарии,
 * переходы. Диалект решает форму: облако отдаёт и ждёт документы ADF, своя установка — текст.
 */
import { JqlError, parseJql, runJql } from './jql.mjs';
import { ACCEPTANCE_FIELD_ID, ACCEPTANCE_FIELD_NAME, WORKFLOW } from './state.mjs';

const FIELD_NAMES = {
  summary: 'Summary',
  description: 'Description',
  status: 'Status',
  issuetype: 'Issue Type',
  assignee: 'Assignee',
  updated: 'Updated',
  created: 'Created',
  labels: 'Labels',
  priority: 'Priority',
  parent: 'Parent',
  issuelinks: 'Linked Issues',
  comment: 'Comment',
  [ACCEPTANCE_FIELD_ID]: ACCEPTANCE_FIELD_NAME,
};

const ok = (body, status = 200) => ({ status, body });
const notFound = (what) => ({ status: 404, body: { errorMessages: [`${what} does not exist`] } });
const bad = (message) => ({ status: 400, body: { errorMessages: [message], errors: {} } });

/** Текст → документ ADF облака: абзац на строку. */
export function adfOf(text) {
  return {
    type: 'doc',
    version: 1,
    content: String(text)
      .split(/\r?\n/)
      .map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
  };
}

/** Документ ADF → текст (для поиска `text ~` по комментариям облака). */
export function textOfAdf(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return String(node.text ?? '');
  const inner = (node.content ?? []).map(textOfAdf);
  return node.type === 'doc' ? inner.join('\n') : inner.join('');
}

const isAdfDoc = (value) =>
  !!value && typeof value === 'object' && value.type === 'doc' && value.version === 1;

/** Поле текста по диалекту: облако — только документ ADF, своя установка — только строка. */
function textField(ctx, value, field) {
  if (ctx.deployment === 'cloud') {
    if (!isAdfDoc(value))
      return { error: bad(`Operation value must be an Atlassian Document (${field})`) };
    return { text: textOfAdf(value) };
  }
  if (typeof value !== 'string')
    return { error: bad(`Operation value must be a string (${field})`) };
  return { text: value };
}

function userView(ctx, name) {
  const user = name ? ctx.state.userByName(name) : null;
  if (!user) return null;
  return ctx.deployment === 'cloud'
    ? { accountId: `acc-${user.name}`, displayName: user.displayName, emailAddress: user.email }
    : { name: user.name, displayName: user.displayName, emailAddress: user.email };
}

function textOut(ctx, text) {
  if (!text) return null;
  return ctx.deployment === 'cloud' ? adfOf(text) : text;
}

function linkView(ctx, link) {
  const words = ctx.state.linkWords(link.type);
  const other = ctx.state.issues.get(link.key);
  const side = { key: link.key, fields: { summary: other?.summary ?? '' } };
  return {
    type: { name: link.type, inward: words.inward, outward: words.outward },
    ...(link.direction === 'inward' ? { inwardIssue: side } : { outwardIssue: side }),
  };
}

function allFields(ctx, issue) {
  const parent = issue.parent ? ctx.state.issues.get(issue.parent) : null;
  return {
    summary: issue.summary,
    description: textOut(ctx, issue.description),
    status: { name: issue.status, statusCategory: { key: issue.statusCategory } },
    issuetype: { name: issue.type },
    assignee: userView(ctx, issue.assignee),
    updated: ctx.state.isoAt(issue.updated),
    created: ctx.state.isoAt(issue.created),
    labels: [...issue.labels],
    priority: { name: issue.priority },
    ...(issue.parent
      ? { parent: { key: issue.parent, fields: { summary: parent?.summary ?? '' } } }
      : {}),
    issuelinks: issue.links.map((l) => linkView(ctx, l)),
    comment: {
      comments: issue.comments.map((c) => commentView(ctx, c)),
      total: issue.comments.length,
    },
    [ACCEPTANCE_FIELD_ID]: issue.acceptance.length
      ? textOut(ctx, issue.acceptance.join('\n'))
      : null,
  };
}

/** Задача в ответе: `fields` — список имён (нет, `*all`, `*navigable` — все), `expand=names`. */
function issueView(ctx, issue, fieldsParam, expand) {
  const every = allFields(ctx, issue);
  const wanted =
    !fieldsParam || fieldsParam === '*all' || fieldsParam === '*navigable'
      ? Object.keys(every)
      : fieldsParam.split(',').map((f) => f.trim());
  const fields = Object.fromEntries(
    wanted.filter((name) => name in every).map((name) => [name, every[name]]),
  );
  const view = {
    id: issue.id,
    key: issue.key,
    self: `${ctx.baseUrl}${ctx.apiRoot}/issue/${issue.id}`,
    fields,
  };
  if (
    String(expand ?? '')
      .split(',')
      .includes('names')
  )
    view.names = Object.fromEntries(Object.keys(fields).map((name) => [name, FIELD_NAMES[name]]));
  return view;
}

function commentView(ctx, comment) {
  return {
    id: comment.id,
    author: userView(ctx, comment.author),
    body: ctx.deployment === 'cloud' ? adfOf(comment.text) : comment.text,
    created: ctx.state.isoAt(comment.created),
  };
}

function search(ctx, modern) {
  const jql = ctx.query.get('jql') ?? '';
  let parsed;
  try {
    parsed = parseJql(jql);
  } catch (error) {
    if (error instanceof JqlError) return bad(`Error in the JQL Query: ${error.message}`);
    throw error;
  }
  const max = Math.min(Math.max(Number(ctx.query.get('maxResults') ?? 50) || 50, 1), 100);
  const start = modern ? 0 : Math.max(Number(ctx.query.get('startAt') ?? 0) || 0, 0);
  const found = runJql([...ctx.state.issues.values()], parsed, ctx.actor);
  const page = found.slice(start, start + max);
  const issues = page.map((i) =>
    issueView(ctx, i, ctx.query.get('fields'), ctx.query.get('expand')),
  );
  if (modern) return ok({ issues, isLast: start + max >= found.length });
  return ok({ startAt: start, maxResults: max, total: found.length, issues });
}

function createIssue(ctx) {
  const fields = ctx.body?.fields ?? {};
  const projectKey = fields.project?.key;
  if (!ctx.state.projects.some((p) => p.key === projectKey))
    return { status: 400, body: { errorMessages: [], errors: { project: 'project is required' } } };
  if (typeof fields.summary !== 'string' || !fields.summary.trim())
    return { status: 400, body: { errorMessages: [], errors: { summary: 'summary is required' } } };
  let description = '';
  if (fields.description !== undefined && fields.description !== null) {
    const parsed = textField(ctx, fields.description, 'description');
    if (parsed.error) return parsed.error;
    description = parsed.text;
  }
  const issue = ctx.state.upsertIssue({
    key: ctx.state.nextKey(projectKey),
    summary: fields.summary,
    description,
    type: fields.issuetype?.name ?? 'Task',
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    ...(fields.priority?.name ? { priority: fields.priority.name } : {}),
  });
  return ok(
    { id: issue.id, key: issue.key, self: `${ctx.baseUrl}${ctx.apiRoot}/issue/${issue.id}` },
    201,
  );
}

function issueRoute(ctx, issue, rest) {
  if (rest.length === 0 && ctx.method === 'GET')
    return ok(issueView(ctx, issue, ctx.query.get('fields'), ctx.query.get('expand')));
  if (rest[0] === 'comment' && rest.length === 1) {
    if (ctx.method === 'GET') {
      const comments = issue.comments.map((c) => commentView(ctx, c));
      return ok({ startAt: 0, maxResults: comments.length, total: comments.length, comments });
    }
    if (ctx.method === 'POST') {
      const parsed = textField(ctx, ctx.body?.body, 'body');
      if (parsed.error) return parsed.error;
      if (!parsed.text.trim()) return bad('Comment body can not be empty!');
      const comment = ctx.state.addComment(issue, ctx.actor, ctx.body.body, parsed.text);
      return ok(commentView(ctx, comment), 201);
    }
  }
  if (rest[0] === 'transitions' && rest.length === 1) {
    if (ctx.method === 'GET')
      return ok({
        transitions: WORKFLOW.map((w) => ({
          id: w.id,
          name: w.name,
          to: { name: w.status, statusCategory: { key: w.category } },
        })),
      });
    if (ctx.method === 'POST') {
      const flow = WORKFLOW.find((w) => w.id === String(ctx.body?.transition?.id ?? ''));
      if (!flow) return bad('Transition id is not valid for this issue');
      ctx.state.upsertIssue({ key: issue.key, status: flow.status, statusCategory: flow.category });
      return { status: 204, text: '' };
    }
  }
  return undefined;
}

/** Маршрут под `/rest/api/<v>`; `undefined` — пути нет в подмножестве. */
export function handleJira(ctx, segments) {
  const [head, ...rest] = segments;
  if (head === 'myself' && rest.length === 0 && ctx.method === 'GET')
    return ok({
      ...userView(ctx, ctx.actor.name),
      ...(ctx.deployment === 'cloud' ? {} : { key: ctx.actor.name }),
    });
  if (head === 'project' && ctx.method === 'GET') {
    const projects = ctx.state.projects.map((p) => ({ id: p.id, key: p.key, name: p.name }));
    if (rest.length === 0) return ok(projects);
    if (rest[0] === 'search' && rest.length === 1 && ctx.deployment === 'cloud')
      return ok({ values: projects, isLast: true, total: projects.length });
    return undefined;
  }
  if (head === 'search' && ctx.method === 'GET') {
    if (rest.length === 0) return search(ctx, false);
    if (rest[0] === 'jql' && rest.length === 1 && ctx.deployment === 'cloud')
      return search(ctx, true);
    return undefined;
  }
  if (head === 'issue') {
    if (rest.length === 0 && ctx.method === 'POST') return createIssue(ctx);
    const issue = ctx.state.issues.get(rest[0] ?? '');
    if (!issue) return rest.length > 0 ? notFound('Issue') : undefined;
    return issueRoute(ctx, issue, rest.slice(1));
  }
  return undefined;
}
