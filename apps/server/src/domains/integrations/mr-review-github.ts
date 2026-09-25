import type { ForgeAccess, MergeRequestRef } from './forge.ts';
import { forgeGraphql } from './forge.ts';
import type { MrReview, MrReviewPipeline, MrReviewThread } from './mr-review.ts';

/**
 * PR GitHub глазами наблюдателя MR. Всё — одним запросом GraphQL: REST не
 * говорит, решена ли ветка ревью (`isResolved` есть только в GraphQL), а исход
 * проверок головы — сводный `statusCheckRollup` последнего коммита, без обхода
 * check-suites и статусов по отдельности.
 *
 * Общие комментарии PR (не к коду) ветками не считаются: закрыть их нельзя, как
 * и у GitLab — нерешаемое обсуждение группу не ждёт.
 */

/** Страниц веток ревью: сотня на странице, тысяча веток — с запасом. */
const MAX_THREAD_PAGES = 10;

const QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      url
      body
      author { login }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          originalLine
          comments(first: 100) {
            nodes { databaseId body createdAt url author { login __typename } }
          }
        }
      }
    }
  }
}`;

interface GhAuthor {
  login?: string;
  __typename?: string;
}

interface GhComment {
  databaseId?: number;
  body?: string;
  createdAt?: string;
  url?: string;
  author?: GhAuthor | null;
}

interface GhThread {
  id: string;
  isResolved?: boolean;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  comments?: { nodes?: (GhComment | null)[] };
}

interface GhPullRequest {
  state?: string;
  url?: string;
  body?: string | null;
  author?: GhAuthor | null;
  commits?: {
    nodes?: ({ commit?: { oid?: string; statusCheckRollup?: { state?: string } | null } } | null)[];
  };
  reviewThreads?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    nodes?: (GhThread | null)[];
  };
}

interface GhAnswer {
  repository?: { pullRequest?: GhPullRequest | null } | null;
}

/** Ветка ревью GitHub. Без единой реплики — `undefined`. */
function toThread(thread: GhThread): MrReviewThread | undefined {
  const comments = (thread.comments?.nodes ?? []).filter(
    (comment): comment is GhComment => comment !== null,
  );
  if (comments.length === 0) return undefined;
  // Строка к устаревшему диффу — `line: null`, место остаётся в `originalLine`.
  const line = thread.line ?? thread.originalLine;
  return {
    id: thread.id,
    // Ветка ревью у GitHub решаема всегда — в отличие от общих комментариев.
    resolvable: true,
    resolved: Boolean(thread.isResolved),
    notes: comments.map((comment) => ({
      id: String(comment.databaseId ?? ''),
      author: comment.author?.login ?? '',
      ...(comment.author?.__typename === 'Bot' ? { bot: true } : {}),
      body: comment.body ?? '',
      ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
      ...(comment.url ? { url: comment.url } : {}),
    })),
    ...(thread.path ? { path: thread.path } : {}),
    ...(typeof line === 'number' ? { line } : {}),
  };
}

function toState(state: string | undefined): MrReview['state'] {
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return 'open';
}

/** Сводный исход проверок — словами наблюдателя (`running`, `success`, `failed`). */
function toStatus(state: string | undefined): string | undefined {
  if (state === 'SUCCESS') return 'success';
  if (state === 'FAILURE' || state === 'ERROR') return 'failed';
  if (state === 'PENDING' || state === 'EXPECTED') return 'running';
  return undefined;
}

/**
 * Проверки головы PR как «конвейер»: номер — хеш головы (новый коммит — новый
 * исход, судится заново), ссылка — вкладка проверок PR.
 */
function toPipeline(pr: GhPullRequest, url: string): MrReviewPipeline | undefined {
  const commit = pr.commits?.nodes?.[0]?.commit;
  const status = toStatus(commit?.statusCheckRollup?.state);
  if (!commit?.oid || !status) return undefined;
  return { id: commit.oid, status, url: `${pr.url ?? url}/checks` };
}

export async function readGithubReview(
  access: ForgeAccess,
  ref: MergeRequestRef,
  url: string,
): Promise<MrReview> {
  const [owner = '', name = ''] = ref.repo.split('/');
  const threads: MrReviewThread[] = [];
  let first: GhPullRequest | undefined;
  let cursor: string | null = null;
  for (let page = 1; page <= MAX_THREAD_PAGES; page += 1) {
    const answer: GhAnswer = await forgeGraphql<GhAnswer>(access, QUERY, {
      owner,
      name,
      number: ref.number,
      cursor,
    });
    const pr = answer.repository?.pullRequest;
    if (!pr) throw new Error(`GitHub GraphQL: pull request ${ref.repo}#${ref.number} not found`);
    first ??= pr;
    for (const node of pr.reviewThreads?.nodes ?? []) {
      const thread = node ? toThread(node) : undefined;
      if (thread) threads.push(thread);
    }
    const info = pr.reviewThreads?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    cursor = info.endCursor;
  }
  const pr = first as GhPullRequest;
  const pipeline = toPipeline(pr, url.replace(/[#?].*$/, '').replace(/\/+$/, ''));
  return {
    state: toState(pr.state),
    ...(pr.author?.login ? { author: pr.author.login } : {}),
    description: pr.body ?? '',
    threads,
    ...(pipeline ? { pipeline } : {}),
  };
}
