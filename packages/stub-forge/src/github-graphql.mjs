/**
 * GraphQL GitHub — только операции нитей ревью, которых нет в REST: чтение `reviewThreads`,
 * ответ `addPullRequestReviewThreadReply`, разрешение `resolveReviewThread`. Запрос не
 * разбирается грамматикой: операция узнаётся по имени поля, данные — из `variables` (переходник
 * шлёт неизменные тексты запросов). Ошибки — как у GitHub: код 200 и массив `errors`.
 */
import { githubUser } from './github.mjs';

/** Слияние и одобрение (P63): операция с таким именем — отказ и строка следа `forbidden`. */
export const GRAPHQL_FORBIDDEN =
  /\b(mergePullRequest|enablePullRequestAutoMerge|addPullRequestReview|submitPullRequestReview|approve\w*)\b/;

const iso = (ms) => new Date(ms).toISOString();

const fail = (message) => ({ status: 200, body: { data: null, errors: [{ message }] } });

function comment(state, note) {
  return {
    id: `PRRC_${note.id}`,
    databaseId: note.id,
    body: note.body,
    createdAt: iso(note.createdAt),
    author: { login: githubUser(state, note.authorId).login },
  };
}

function thread(state, discussion) {
  return {
    id: discussion.id,
    isResolved: discussion.resolved,
    comments: { nodes: discussion.notes.map((note) => comment(state, note)) },
  };
}

export function handleGraphql(ctx) {
  const { state, body, actor } = ctx;
  const query = typeof body.query === 'string' ? body.query : '';
  const vars = body.variables ?? {};
  const byThread = () => state.discussions.find((d) => d.resolvable && d.id === vars.threadId);
  if (query.includes('addPullRequestReviewThreadReply')) {
    const discussion = byThread();
    if (!discussion)
      return fail(`Could not resolve to a node with the global id of '${vars.threadId}'`);
    const note = state.addNote(discussion, actor.id, String(vars.body ?? ''));
    return {
      status: 200,
      body: { data: { addPullRequestReviewThreadReply: { comment: comment(state, note) } } },
    };
  }
  if (query.includes('resolveReviewThread')) {
    const discussion = byThread();
    if (!discussion)
      return fail(`Could not resolve to a node with the global id of '${vars.threadId}'`);
    state.resolveDiscussion(discussion, true);
    return {
      status: 200,
      body: { data: { resolveReviewThread: { thread: { id: discussion.id, isResolved: true } } } },
    };
  }
  if (query.includes('reviewThreads')) {
    const project = state.project(`${vars.owner}/${vars.name}`);
    const mr =
      project && state.mrs.find((m) => m.projectId === project.id && m.iid === Number(vars.number));
    if (!mr) return fail('Could not resolve to a PullRequest');
    const threads = state.discussions.filter(
      (d) => d.projectId === mr.projectId && d.mrIid === mr.iid && d.resolvable,
    );
    return {
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: { reviewThreads: { nodes: threads.map((d) => thread(state, d)) } },
          },
        },
      },
    };
  }
  return fail('stub-forge: operation not in the subset');
}
