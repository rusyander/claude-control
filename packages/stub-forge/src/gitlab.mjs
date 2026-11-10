/**
 * GitLab REST v4 — то подмножество, которым пользуется публикатор ядра (05 §Push and MR): учётка,
 * проект, MR (список по исходной ветке, создание, правка, чтение), нити (список, ответ,
 * разрешение), конвейеры по sha, задания и их логи, события проекта. Формы ответов — как у
 * GitLab: переходник ядра разбирает здесь ровно то, что разберёт у настоящего сервера.
 */

import { globalIssues, hasLabels, issueRoutes, newestFirst } from './gitlab-inbox.mjs';
import { pageOf } from './paging.mjs';

const iso = (ms) => new Date(ms).toISOString();

function author(state, id) {
  const u = state.user(id);
  return { id: u.id, username: u.username, name: u.username };
}

export function gitlabMr(state, baseUrl, mr) {
  const project = state.project(mr.projectId);
  return {
    id: mr.id,
    iid: mr.iid,
    project_id: mr.projectId,
    title: mr.draft ? `Draft: ${mr.title}` : mr.title,
    description: mr.body,
    state: { open: 'opened', closed: 'closed', merged: 'merged' }[mr.state],
    draft: mr.draft,
    work_in_progress: mr.draft,
    source_branch: mr.sourceBranch,
    target_branch: mr.targetBranch,
    sha: mr.headSha,
    author: author(state, mr.authorId),
    created_at: iso(mr.createdAt),
    updated_at: iso(mr.updatedAt),
    web_url: `${baseUrl}/${project.path}/-/merge_requests/${mr.iid}`,
    has_conflicts: mr.conflict,
    detailed_merge_status: mr.checking ? 'checking' : mr.conflict ? 'conflict' : 'mergeable',
    labels: [...(mr.labels ?? [])],
    reviewers: (mr.reviewerIds ?? []).map((id) => author(state, id)),
    references: { short: `!${mr.iid}`, relative: `!${mr.iid}`, full: `${project.path}!${mr.iid}` },
  };
}

const MR_STATE = { open: 'opened', closed: 'closed', merged: 'merged' };

/**
 * `GET /merge_requests` — MR по всему сайту (входящие ядра): `scope` по умолчанию у GitLab —
 * `created_by_me`; ревьюер — `reviewer_username` или `reviewer_id`; новые первыми, страницами.
 */
function globalMrs(ctx) {
  const { state, query, actor, baseUrl } = ctx;
  const scope = query.get('scope') ?? 'created_by_me';
  const reviewer = query.get('reviewer_username');
  const reviewerId = query.get('reviewer_id');
  const authorName = query.get('author_username');
  const asked = query.get('state');
  const found = state.mrs
    .filter((m) => scope !== 'created_by_me' || m.authorId === actor.id)
    .filter((m) => !reviewer || m.reviewerIds.some((id) => state.user(id).username === reviewer))
    .filter((m) => !reviewerId || m.reviewerIds.some((id) => String(id) === reviewerId))
    .filter((m) => !authorName || state.user(m.authorId).username === authorName)
    .filter((m) => !asked || asked === 'all' || MR_STATE[m.state] === asked)
    .filter((m) => hasLabels(m, query));
  return ok(pageOf(newestFirst(found, query), query, 20).map((m) => gitlabMr(state, baseUrl, m)));
}

function gitlabNote(state, discussion, note) {
  return {
    id: note.id,
    type: discussion.resolvable ? 'DiscussionNote' : null,
    body: note.body,
    author: author(state, note.authorId),
    created_at: iso(note.createdAt),
    system: false,
    resolvable: discussion.resolvable,
    resolved: discussion.resolved,
    noteable_type: 'MergeRequest',
    noteable_iid: discussion.mrIid,
  };
}

function gitlabDiscussion(state, discussion) {
  return {
    id: discussion.id,
    individual_note: !discussion.resolvable,
    notes: discussion.notes.map((note) => gitlabNote(state, discussion, note)),
  };
}

const JOB_STATUS = new Set(['created', 'pending', 'running', 'success', 'failed', 'canceled']);

function gitlabJob(job) {
  return {
    id: job.id,
    name: job.name,
    status: JOB_STATUS.has(job.status) ? job.status : 'skipped',
    failure_reason: job.status === 'failed' ? (job.failureReason ?? 'script_failure') : undefined,
    started_at: job.startedAt === null ? null : iso(job.startedAt),
  };
}

const EVENT_ACTION = {
  push: 'pushed to',
  'branch-delete': 'deleted',
  'mr-open': 'opened',
  'mr-update': 'updated',
  note: 'commented on',
  approval: 'approved',
  merge: 'accepted',
};

function gitlabEvent(state, event) {
  const out = {
    id: event.id,
    project_id: event.projectId,
    action_name: EVENT_ACTION[event.type],
    author: author(state, event.authorId),
    author_id: event.authorId,
    created_at: iso(event.at),
    target_iid: event.mrIid ?? null,
    target_id: event.objectId === undefined ? null : Number(event.objectId),
    target_type: null,
  };
  if (event.type === 'push' || event.type === 'branch-delete') {
    out.push_data = {
      ref: event.ref,
      ref_type: 'branch',
      action: event.type === 'push' ? 'pushed' : 'removed',
    };
  } else if (event.type === 'note') {
    out.target_type = 'DiscussionNote';
    out.note = {
      id: Number(event.objectId),
      noteable_type: 'MergeRequest',
      noteable_iid: event.mrIid,
    };
  } else {
    out.target_type = 'MergeRequest';
  }
  return out;
}

const ok = (body) => ({ status: 200, body });
const created = (body) => ({ status: 201, body });
const notFound = (what) => ({ status: 404, body: { message: `404 ${what} Not Found` } });

/** Дата `after` GitLab — сутки, событие строго после конца этих суток. */
function afterDay(text) {
  const day = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(day) ? -Infinity : day + 86_400_000;
}

function mrRoutes(ctx, project, rest) {
  const { state, method, query, body, actor, baseUrl } = ctx;
  const list = state.mrs.filter((m) => m.projectId === project.id);
  if (rest.length === 0 && method === 'GET') {
    const source = query.get('source_branch');
    const authorId = query.get('author_id');
    const authorName = query.get('author_username');
    const after = query.get('created_after');
    // GitLab: «created on or after» — граница включена.
    const afterMs = after ? Date.parse(after) : -Infinity;
    const found = list
      .filter((m) => !source || m.sourceBranch === source)
      .filter((m) => !authorId || String(m.authorId) === authorId)
      .filter((m) => !authorName || state.user(m.authorId).username === authorName)
      .filter((m) => m.createdAt >= afterMs)
      .sort((a, b) => b.createdAt - a.createdAt);
    return ok(found.map((m) => gitlabMr(state, baseUrl, m)));
  }
  if (rest.length === 0 && method === 'POST') {
    const title = String(body.title ?? '');
    const draft = /^(draft:|\[draft\]|\(draft\))\s*/i.test(title);
    const mr = state.createMr(project.id, actor.id, {
      title: title.replace(/^(draft:|\[draft\]|\(draft\))\s*/i, ''),
      body: body.description ?? '',
      draft,
      sourceBranch: body.source_branch,
      targetBranch: body.target_branch,
      headSha: ctx.headOf(body.source_branch),
    });
    return created(gitlabMr(state, baseUrl, mr));
  }
  const mr = list.find((m) => String(m.iid) === rest[0]);
  if (!mr) return notFound('Merge Request');
  if (rest.length === 1 && method === 'GET') {
    if (mr.headSha === null) mr.headSha = ctx.headOf(mr.sourceBranch);
    return ok(gitlabMr(state, baseUrl, mr));
  }
  if (rest.length === 1 && method === 'PUT') {
    const input = { body: body.description };
    if (body.title !== undefined) {
      const title = String(body.title);
      input.draft = /^(draft:|\[draft\]|\(draft\))\s*/i.test(title);
      input.title = title.replace(/^(draft:|\[draft\]|\(draft\))\s*/i, '');
    }
    return ok(gitlabMr(state, baseUrl, state.updateMr(mr, actor.id, input)));
  }
  if (rest[1] === 'discussions') return discussionRoutes(ctx, mr, rest.slice(2));
  return undefined;
}

function discussionRoutes(ctx, mr, rest) {
  const { state, method, query, body, actor } = ctx;
  const mine = state.discussions.filter((d) => d.projectId === mr.projectId && d.mrIid === mr.iid);
  // Как у GitLab: страница `page` по `per_page` (по умолчанию 20, не больше 100), старые первыми.
  if (rest.length === 0 && method === 'GET')
    return ok(pageOf(mine, query, 20).map((d) => gitlabDiscussion(state, d)));
  if (rest.length === 0 && method === 'POST')
    return created(gitlabDiscussion(state, state.addDiscussion(mr, actor.id, String(body.body))));
  const discussion = mine.find((d) => d.id === rest[0]);
  if (!discussion) return notFound('Discussion');
  if (rest.length === 1 && method === 'PUT') {
    const resolved = String(query.get('resolved') ?? body.resolved) === 'true';
    return ok(gitlabDiscussion(state, state.resolveDiscussion(discussion, resolved)));
  }
  if (rest[1] === 'notes' && rest.length === 2 && method === 'POST') {
    const note = state.addNote(discussion, actor.id, String(body.body ?? ''));
    return created(gitlabNote(state, discussion, note));
  }
  return undefined;
}

function ciRoutes(ctx, project, head, rest) {
  const { state, method, query } = ctx;
  if (method !== 'GET') return undefined;
  if (head === 'pipelines' && rest.length === 0) {
    const sha = query.get('sha');
    const ref = query.get('ref');
    const found = state.pipelines
      .filter((p) => p.projectId === project.id)
      .filter((p) => !sha || p.sha === sha)
      .filter((p) => !ref || p.ref === ref)
      .sort((a, b) => b.id - a.id);
    return ok(
      found.map((p) => ({
        id: p.id,
        sha: p.sha,
        ref: p.ref,
        status: p.status,
        created_at: iso(p.createdAt),
      })),
    );
  }
  if (head === 'pipelines' && rest[1] === 'jobs') {
    const pipeline = state.pipelines.find(
      (p) => p.projectId === project.id && String(p.id) === rest[0],
    );
    return pipeline ? ok(pipeline.jobs.map(gitlabJob)) : notFound('Pipeline');
  }
  if (head === 'jobs' && rest[1] === 'trace') {
    const job = state.pipelines
      .filter((p) => p.projectId === project.id)
      .flatMap((p) => p.jobs)
      .find((j) => String(j.id) === rest[0]);
    return job ? { status: 200, text: job.trace } : notFound('Job');
  }
  return undefined;
}

/** `path` — после `/api/v4`; `undefined` — такого пути у GitLab-подмножества нет (404). */
export function handleGitlab(ctx, path) {
  const { state, method, query } = ctx;
  if (path[0] === 'user' && path.length === 1 && method === 'GET')
    return ok({ id: ctx.actor.id, username: ctx.actor.username, name: ctx.actor.username });
  if (path.length === 1 && method === 'GET' && path[0] === 'issues') return globalIssues(ctx);
  if (path.length === 1 && method === 'GET' && path[0] === 'merge_requests') return globalMrs(ctx);
  if (path[0] !== 'projects' || path.length < 2) return undefined;
  const project = state.project(path[1]);
  if (!project) return notFound('Project');
  const rest = path.slice(2);
  if (rest.length === 0 && method === 'GET') {
    return ok({
      id: project.id,
      path_with_namespace: project.path,
      default_branch: project.defaultBranch,
      web_url: `${ctx.baseUrl}/${project.path}`,
    });
  }
  if (rest[0] === 'merge_requests') return mrRoutes(ctx, project, rest.slice(1));
  if (rest[0] === 'issues') return issueRoutes(ctx, project, rest.slice(1));
  if (rest[0] === 'pipelines' || rest[0] === 'jobs')
    return ciRoutes(ctx, project, rest[0], rest.slice(1));
  if (rest[0] === 'events' && rest.length === 1 && method === 'GET') {
    const after = query.get('after');
    const from = after ? afterDay(after) : -Infinity;
    const found = state.events
      .filter((e) => e.projectId === project.id && e.at >= from)
      .sort((a, b) => b.id - a.id);
    // Как у GitLab: новые первыми, страница `page` по `per_page` (по умолчанию 20, не больше 100).
    return ok(pageOf(found, query, 20).map((e) => gitlabEvent(state, e)));
  }
  return undefined;
}
