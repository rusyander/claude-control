/**
 * Управление заглушкой со стороны теста: действия «другого человека» (ревьюер ответил, кто-то
 * запушил или слил), засев конвейеров, снимок памяти, связь с голым репозиторием. Каждое
 * действие пишет событие с автором — страж отличит его от действий публикатора (P29).
 * Доступно и вызовом (`stub.act`), и путём `/__stub/*` для голого node.
 */
import { execFileSync } from 'node:child_process';
import { deserialize, serialize } from 'node:v8';

function gitOut(repo, args) {
  try {
    return execFileSync('git', ['--git-dir', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** Ветки голого репозитория → sha; без репозитория — пусто. */
function branchesOf(repo) {
  const out = repo
    ? gitOut(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'])
    : '';
  const refs = {};
  for (const line of (out ?? '').split('\n')) {
    const [sha, ref] = line.split(' ');
    if (sha && ref) refs[ref.replace(/^refs\/heads\//, '')] = sha;
  }
  return refs;
}

export function createControl(state, repo) {
  let known = branchesOf(repo);

  const projectOf = (ref) => {
    const project = ref === undefined ? state.projects[0] : state.project(ref);
    if (!project) throw new TypeError(`stub-forge: no project «${ref}»`);
    return project;
  };
  const mrOf = (project, iid) => {
    const mr = state.mrs.find((m) => m.projectId === project.id && m.iid === Number(iid));
    if (!mr) throw new TypeError(`stub-forge: no MR !${iid}`);
    return mr;
  };
  const threadOf = (mr, id) => {
    const found = state.discussions.find(
      (d) => d.mrIid === mr.iid && d.projectId === mr.projectId && d.id === id,
    );
    if (!found) throw new TypeError(`stub-forge: no thread ${id}`);
    return found;
  };

  /** Голова ветки: из голого репозитория, если он назван; иначе — последний `push` теста. */
  function headOf(branch) {
    const name = String(branch ?? '').replace(/^[^:]+:/, '');
    if (repo) return gitOut(repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]) || null;
    const push = [...state.events]
      .reverse()
      .find((e) => e.type === 'push' && e.ref === name && e.sha);
    return push?.sha ?? null;
  }

  /** Сравнить ветки репозитория со снимком: новое — `push`, пропавшее — `branch-delete`. */
  function syncPushes(as = 'publisher', projectRef) {
    const project = projectOf(projectRef);
    const author = state.user(as).id;
    const now = branchesOf(repo);
    const out = [];
    for (const [ref, sha] of Object.entries(now))
      if (known[ref] !== sha) out.push(state.event(project.id, 'push', author, { ref, sha }));
    for (const ref of Object.keys(known))
      if (!(ref in now)) out.push(state.event(project.id, 'branch-delete', author, { ref }));
    for (const mr of state.mrs)
      if (mr.projectId === project.id && now[mr.sourceBranch]) mr.headSha = now[mr.sourceBranch];
    known = now;
    return out;
  }

  const idsOf = (names) => (names ?? []).map((name) => state.user(name).id);
  const issueOf = (project, iid) => {
    const issue = state.issues.find((i) => i.projectId === project.id && i.iid === Number(iid));
    if (!issue) throw new TypeError(`stub-forge: no issue #${iid}`);
    return issue;
  };

  /** Действия входящих ядра: задачи форжа, их связи, ревьюеры и закрытие MR. */
  function actInbox(author, project, action) {
    switch (action.type) {
      case 'issue-open':
        return state.createIssue(project.id, author, {
          ...action,
          assigneeIds: idsOf(action.assignees),
        });
      case 'issue-update':
        return state.updateIssue(issueOf(project, action.iid), action);
      case 'issue-link':
        return state.linkIssues(
          issueOf(project, action.iid),
          issueOf(projectOf(action.targetProject ?? action.project), action.targetIid),
        );
      case 'mr-reviewers': {
        const mr = mrOf(project, action.mrIid);
        mr.reviewerIds = idsOf(action.reviewers);
        return mr;
      }
      case 'mr-close': {
        const mr = mrOf(project, action.mrIid);
        mr.state = 'closed';
        mr.updatedAt = state.now();
        return mr;
      }
      default:
        return undefined;
    }
  }

  function act(as, action) {
    const author = state.user(as).id;
    const project = projectOf(action.project);
    const inbox = actInbox(author, project, action);
    if (inbox !== undefined) return inbox;
    switch (action.type) {
      case 'mr-open':
        return state.createMr(project.id, author, {
          ...action,
          reviewerIds: idsOf(action.reviewers),
          headSha: action.headSha ?? headOf(action.sourceBranch),
        });
      case 'mr-update':
        return state.updateMr(mrOf(project, action.mrIid), author, action);
      case 'note': {
        const mr = mrOf(project, action.mrIid);
        if (action.threadId)
          return state.addNote(threadOf(mr, action.threadId), author, action.body);
        return state.addDiscussion(mr, author, action.body, action.resolvable ?? true);
      }
      case 'resolve':
        return state.resolveDiscussion(
          threadOf(mrOf(project, action.mrIid), action.threadId),
          action.resolved ?? true,
        );
      case 'push': {
        for (const mr of state.mrs)
          if (mr.projectId === project.id && mr.sourceBranch === action.ref && action.sha)
            mr.headSha = action.sha;
        return state.event(project.id, 'push', author, { ref: action.ref, sha: action.sha });
      }
      case 'branch-delete':
        return state.event(project.id, 'branch-delete', author, { ref: action.ref });
      case 'approval':
        return state.event(project.id, 'approval', author, { mrIid: Number(action.mrIid) });
      case 'merge': {
        const mr = mrOf(project, action.mrIid);
        mr.state = 'merged';
        return state.event(project.id, 'merge', author, { mrIid: mr.iid, objectId: String(mr.id) });
      }
      case 'pipeline':
        return state.addPipeline(project.id, action);
      case 'mergeability': {
        const mr = mrOf(project, action.mrIid);
        mr.conflict = Boolean(action.conflict);
        mr.checking = Boolean(action.checking);
        return mr;
      }
      default:
        throw new TypeError(`stub-forge: unknown act «${action.type}»`);
    }
  }

  /** Снимок памяти без значений доступа учёток. */
  function snapshot() {
    // Глубокая копия тем же алгоритмом, что `structuredClone`, без глобала вне линта пакета.
    return deserialize(
      serialize({
        users: state.users.map(({ id, username }) => ({ id, username })),
        projects: state.projects,
        mrs: state.mrs,
        discussions: state.discussions,
        pipelines: state.pipelines,
        events: state.events,
        issues: state.issues,
        issueLinks: state.issueLinks,
      }),
    );
  }

  return { act, headOf, syncPushes, snapshot };
}
