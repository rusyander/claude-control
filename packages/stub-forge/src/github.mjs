/**
 * GitHub REST — подмножество публикатора: учётка, репозиторий, запросы на слияние (список по
 * `head`, создание, правка, чтение), комментарии к issue, проверки и прогоны Actions с заданиями
 * и логами, события репозитория. Пути — как у своей инсталляции (`/api/v3/…`) и как у облака
 * (`/repos/…` от корня): переходник ядра выбирает корень сам. Нити ревью — в `github-graphql.mjs`.
 */

import { GITHUB_EVENTS_MAX, pageOf, pageSize } from './paging.mjs';

const iso = (ms) => new Date(ms).toISOString();

const ok = (body) => ({ status: 200, body });
const created = (body) => ({ status: 201, body });
const notFound = () => ({ status: 404, body: { message: 'Not Found' } });

export function githubUser(state, id) {
  const u = state.user(id);
  return { id: u.id, login: u.username, type: 'User' };
}

function githubPr(state, baseUrl, mr) {
  const project = state.project(mr.projectId);
  const owner = project.path.split('/')[0];
  return {
    id: mr.id,
    node_id: `PR_${mr.id}`,
    number: mr.iid,
    html_url: `${baseUrl}/${project.path}/pull/${mr.iid}`,
    state: mr.state === 'open' ? 'open' : 'closed',
    merged_at: mr.state === 'merged' ? iso(mr.updatedAt) : null,
    draft: mr.draft,
    title: mr.title,
    body: mr.body,
    user: githubUser(state, mr.authorId),
    head: { ref: mr.sourceBranch, sha: mr.headSha, label: `${owner}:${mr.sourceBranch}` },
    base: { ref: mr.targetBranch },
    created_at: iso(mr.createdAt),
    updated_at: iso(mr.updatedAt),
    mergeable: mr.checking ? null : !mr.conflict,
    mergeable_state: mr.checking ? 'unknown' : mr.conflict ? 'dirty' : 'clean',
  };
}

/** Статус задания GitLab-модели → `status` + `conclusion` GitHub Actions. */
function runStatus(status, conclusion) {
  if (status === 'running') return { status: 'in_progress', conclusion: null };
  if (status === 'created' || status === 'pending') return { status: 'queued', conclusion: null };
  const fallback = {
    success: 'success',
    failed: 'failure',
    canceled: 'cancelled',
    skipped: 'skipped',
  };
  return { status: 'completed', conclusion: conclusion ?? fallback[status] ?? 'neutral' };
}

/** Шаги задания: первый — подготовка раннера; скрипт — второй, если он стартовал. */
function steps(job) {
  const setup = { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' };
  if (job.startedAt === null) return [];
  if (job.scriptStarted === false)
    return [setup, { number: 2, name: 'Run tests', status: 'queued', conclusion: null }];
  const run = runStatus(job.status, null);
  return [setup, { number: 2, name: 'Run tests', ...run }];
}

function githubJob(job, runId) {
  return {
    id: job.id,
    run_id: runId,
    name: job.name,
    ...runStatus(job.status, job.conclusion),
    started_at: job.startedAt === null ? null : iso(job.startedAt),
    steps: steps(job),
  };
}

function githubEvent(state, event) {
  const base = {
    id: String(event.id),
    actor: githubUser(state, event.authorId),
    created_at: iso(event.at),
  };
  const pr = { number: event.mrIid };
  switch (event.type) {
    case 'push':
      return { ...base, type: 'PushEvent', payload: { ref: `refs/heads/${event.ref}` } };
    case 'branch-delete':
      return { ...base, type: 'DeleteEvent', payload: { ref: event.ref, ref_type: 'branch' } };
    case 'mr-open':
    case 'mr-update':
    case 'merge':
      return {
        ...base,
        type: 'PullRequestEvent',
        payload: {
          action: { 'mr-open': 'opened', 'mr-update': 'edited', merge: 'closed' }[event.type],
          number: event.mrIid,
          pull_request: { ...pr, merged: event.type === 'merge' },
        },
      };
    case 'note':
      return {
        ...base,
        type: 'PullRequestReviewCommentEvent',
        payload: { action: 'created', pull_request: pr, comment: { id: Number(event.objectId) } },
      };
    default:
      return {
        ...base,
        type: 'PullRequestReviewEvent',
        payload: { action: 'submitted', pull_request: pr, review: { state: 'approved' } },
      };
  }
}

function pullRoutes(ctx, project, rest) {
  const { state, method, query, body, actor, baseUrl } = ctx;
  const list = state.mrs.filter((m) => m.projectId === project.id);
  if (rest.length === 0 && method === 'GET') {
    const head = query.get('head');
    const branch = head?.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
    const want = query.get('state') ?? 'open';
    const found = list
      .filter((m) => !branch || m.sourceBranch === branch)
      .filter((m) => want === 'all' || (want === 'open') === (m.state === 'open'))
      .sort((a, b) => b.createdAt - a.createdAt);
    return ok(found.map((m) => githubPr(state, baseUrl, m)));
  }
  if (rest.length === 0 && method === 'POST') {
    const mr = state.createMr(project.id, actor.id, {
      title: String(body.title ?? ''),
      body: body.body ?? '',
      draft: Boolean(body.draft),
      sourceBranch: body.head?.includes(':')
        ? body.head.slice(body.head.indexOf(':') + 1)
        : body.head,
      targetBranch: body.base,
      headSha: ctx.headOf(body.head),
    });
    return created(githubPr(state, baseUrl, mr));
  }
  const mr = list.find((m) => String(m.iid) === rest[0]);
  if (!mr) return notFound();
  if (rest.length === 1 && method === 'GET') {
    if (mr.headSha === null) mr.headSha = ctx.headOf(mr.sourceBranch);
    return ok(githubPr(state, baseUrl, mr));
  }
  if (rest.length === 1 && method === 'PATCH')
    return ok(
      githubPr(
        state,
        baseUrl,
        state.updateMr(mr, actor.id, { title: body.title, body: body.body }),
      ),
    );
  return undefined;
}

function actionsRoutes(ctx, project, rest) {
  const { state, query } = ctx;
  const mine = state.pipelines.filter((p) => p.projectId === project.id);
  if (rest[0] === 'runs' && rest.length === 1) {
    const sha = query.get('head_sha');
    const runs = mine
      .filter((p) => !sha || p.sha === sha)
      .sort((a, b) => b.id - a.id)
      .map((p) => ({
        id: p.id,
        head_sha: p.sha,
        head_branch: p.ref,
        created_at: iso(p.createdAt),
        ...runStatus(p.status, null),
      }));
    return ok({ total_count: runs.length, workflow_runs: runs });
  }
  if (rest[0] === 'runs' && rest[2] === 'jobs') {
    const run = mine.find((p) => String(p.id) === rest[1]);
    return run
      ? ok({ total_count: run.jobs.length, jobs: run.jobs.map((j) => githubJob(j, run.id)) })
      : notFound();
  }
  if (rest[0] === 'jobs' && rest[2] === 'logs') {
    const job = mine.flatMap((p) => p.jobs).find((j) => String(j.id) === rest[1]);
    return job ? { status: 200, text: job.trace } : notFound();
  }
  return undefined;
}

function issueComments(ctx, project, rest) {
  const { state, method, body, actor } = ctx;
  const mr = state.mrs.find((m) => m.projectId === project.id && String(m.iid) === rest[0]);
  if (!mr || rest[1] !== 'comments' || rest.length !== 2) return mr ? undefined : notFound();
  const comments = state.discussions.filter(
    (d) => d.projectId === project.id && d.mrIid === mr.iid && !d.resolvable,
  );
  const render = (d) => ({
    id: d.notes[0].id,
    body: d.notes[0].body,
    user: githubUser(state, d.notes[0].authorId),
    created_at: iso(d.notes[0].createdAt),
  });
  if (method === 'GET') return ok(comments.map(render));
  if (method === 'POST')
    return created(render(state.addDiscussion(mr, actor.id, String(body.body ?? ''), false)));
  return undefined;
}

/** `path` — после корня REST (облако или `/api/v3`); `undefined` — пути нет (404). */
export function handleGithub(ctx, path) {
  const { state, method, query } = ctx;
  if (path[0] === 'user' && path.length === 1 && method === 'GET')
    return ok(githubUser(state, ctx.actor.id));
  if (path[0] !== 'repos' || path.length < 3) return undefined;
  const project = state.project(`${path[1]}/${path[2]}`);
  if (!project) return notFound();
  const rest = path.slice(3);
  if (rest.length === 0 && method === 'GET')
    return ok({ id: project.id, full_name: project.path, default_branch: project.defaultBranch });
  if (rest[0] === 'pulls') return pullRoutes(ctx, project, rest.slice(1));
  if (rest[0] === 'issues') return issueComments(ctx, project, rest.slice(1));
  if (method !== 'GET') return undefined;
  if (rest[0] === 'actions') return actionsRoutes(ctx, project, rest.slice(1));
  if (rest[0] === 'commits' && rest[2] === 'check-runs') {
    const runs = state.pipelines.filter((p) => p.projectId === project.id && p.sha === rest[1]);
    const checks = runs.flatMap((p) =>
      p.jobs.map((j) => ({ ...githubJob(j, p.id), head_sha: p.sha })),
    );
    return ok({ total_count: checks.length, check_runs: checks });
  }
  if (rest[0] === 'events' && rest.length === 1) {
    const found = state.events
      .filter((e) => e.projectId === project.id)
      .sort((a, b) => b.id - a.id);
    // Как у GitHub: новые первыми, страницы по `per_page` (30 по умолчанию, не больше 100), и лента
    // отдаёт не больше 300 событий — страница за этим пределом отвечает 422.
    const size = pageSize(query, 30);
    const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
    if ((page - 1) * size >= GITHUB_EVENTS_MAX)
      return { status: 422, body: { message: 'pagination is limited for this resource' } };
    return ok(
      pageOf(found.slice(0, GITHUB_EVENTS_MAX), query, 30).map((e) => githubEvent(state, e)),
    );
  }
  return undefined;
}
