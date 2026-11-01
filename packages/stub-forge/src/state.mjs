/**
 * Память заглушки форжа: проекты, учётки, MR, нити и заметки, конвейеры и задания, лента
 * событий. Одна модель на оба вида — GitLab и GitHub читают те же записи каждый в своей форме,
 * поэтому сценарий пишется один раз. Время — миллисекунды с часов вызывающего (`now`): тест
 * сверки двигает их сам, а не ждёт настоящих.
 *
 * Каждая запись в форж оставляет событие с автором: так страж конца шага отличает действие
 * публикатора от чужого (P29), а сверка outbox находит заметку и MR по автору и времени.
 */
import { createHash } from 'node:crypto';

/** Значение доступа учётки заглушки: выдуманное, собирается из имени (настоящих здесь нет). */
export function stubAccess(username) {
  return ['stub', 'access', username].join('-');
}

/** Учётки по умолчанию: публикатор ядра и ревьюер — «другой человек» для нитей и событий. */
export const DEFAULT_USERS = Object.freeze(
  ['publisher', 'reviewer'].map((username, i) =>
    Object.freeze({ id: i + 1, username, token: stubAccess(username) }),
  ),
);

export const DEFAULT_PROJECT = Object.freeze({ id: 101, path: 'acme/app', defaultBranch: 'main' });

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Хеш тела MR так же, как его считает переходник: `title + "\n" + body` (G10). */
export function mrBodyHash(title, body) {
  return sha256(`${title}\n${body ?? ''}`);
}

function hex40(seed) {
  return sha256(String(seed)).slice(0, 40);
}

export function createState(options = {}) {
  const now = options.now ?? Date.now;
  const users = (options.users ?? DEFAULT_USERS).map((u) => ({ ...u }));
  const projects = (options.projects ?? [DEFAULT_PROJECT]).map((p) => ({
    defaultBranch: 'main',
    ...p,
  }));
  let seq = 1000;
  const next = () => ++seq;
  const mrs = [];
  const discussions = [];
  const pipelines = [];
  const events = [];
  const hooks = { mrCreated: [] };

  const user = (ref) => {
    const found = users.find((u) => u.id === ref || u.username === ref);
    if (!found) throw new Error(`stub-forge: no user «${ref}»`);
    return found;
  };
  const userByToken = (token) => (token ? users.find((u) => u.token === token) : undefined);
  const project = (ref) => {
    const text = String(ref);
    return projects.find((p) => String(p.id) === text || p.path === text);
  };

  function event(projectId, type, authorId, fields = {}) {
    const record = { id: next(), projectId, type, authorId, at: now(), ...fields };
    events.push(record);
    return record;
  }

  function createMr(projectId, authorId, input) {
    const at = now();
    const iid = mrs.filter((m) => m.projectId === projectId).length + 1;
    const mr = {
      id: next(),
      iid,
      projectId,
      title: input.title,
      body: input.body ?? '',
      draft: Boolean(input.draft),
      state: 'open',
      authorId,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      headSha: input.headSha ?? null,
      createdAt: at,
      updatedAt: at,
      conflict: false,
      checking: false,
    };
    mrs.push(mr);
    event(projectId, 'mr-open', authorId, { mrIid: iid, objectId: String(mr.id) });
    for (const hook of hooks.mrCreated) hook(mr);
    return mr;
  }

  function updateMr(mr, authorId, input) {
    if (input.title !== undefined) mr.title = input.title;
    if (input.body !== undefined) mr.body = input.body;
    if (input.draft !== undefined) mr.draft = Boolean(input.draft);
    mr.updatedAt = now();
    event(mr.projectId, 'mr-update', authorId, { mrIid: mr.iid, objectId: String(mr.id) });
    return mr;
  }

  function addNote(discussion, authorId, body) {
    const note = { id: next(), authorId, body, createdAt: now() };
    discussion.notes.push(note);
    event(discussion.projectId, 'note', authorId, {
      mrIid: discussion.mrIid,
      objectId: String(note.id),
    });
    return note;
  }

  function addDiscussion(mr, authorId, body, resolvable = true) {
    const discussion = {
      id: hex40(`d${next()}`),
      projectId: mr.projectId,
      mrIid: mr.iid,
      resolvable,
      resolved: false,
      notes: [],
    };
    discussions.push(discussion);
    addNote(discussion, authorId, body);
    return discussion;
  }

  function resolveDiscussion(discussion, resolved = true) {
    discussion.resolved = resolved;
    return discussion;
  }

  function addPipeline(projectId, input) {
    const pipeline = {
      id: next(),
      projectId,
      sha: input.sha,
      ref: input.ref ?? null,
      status: input.status ?? 'success',
      createdAt: input.createdAt ?? now(),
      jobs: (input.jobs ?? []).map((job) => ({
        id: next(),
        name: job.name ?? 'test',
        status: job.status ?? 'success',
        failureReason: job.failureReason ?? null,
        startedAt: job.startedAt === undefined ? now() : job.startedAt,
        scriptStarted: job.scriptStarted === undefined ? true : job.scriptStarted,
        conclusion: job.conclusion ?? null,
        trace: job.trace ?? defaultTrace(job),
      })),
    };
    pipelines.push(pipeline);
    return pipeline;
  }

  return {
    now,
    users,
    projects,
    mrs,
    discussions,
    pipelines,
    events,
    hooks,
    user,
    userByToken,
    project,
    event,
    createMr,
    updateMr,
    addDiscussion,
    addNote,
    resolveDiscussion,
    addPipeline,
    nextId: next,
  };
}

/**
 * Лог задания, как его пишет раннер GitLab: разделы `section_start`; `step_script` есть, только
 * если скрипт стартовал — по нему разбор CI отделяет таймаут подготовки от красного кода.
 */
function defaultTrace(job) {
  const lines = ['section_start:1:prepare_executor\r\x1b[0KPreparing the executor'];
  if (job.scriptStarted !== false) {
    lines.push('section_start:2:step_script\r\x1b[0KExecuting "step_script" stage');
    lines.push(job.status === 'failed' ? 'FAIL src/app.test.ts' : 'ok');
  } else {
    lines.push('ERROR: Job failed: execution took longer than 1h0m0s seconds');
  }
  return `${lines.join('\n')}\n`;
}
