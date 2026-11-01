import type {
  ForgeActivity,
  ForgeActivityType,
  ForgeJob,
  ForgeJobStatus,
  ForgeMr,
  ForgeNote,
  ForgeThread,
} from '@agentdeck/contracts/core/forge';
import { asArray, isRecord, ms } from './http.ts';
import { mrBodyHash, noteHash } from './hash.ts';

/**
 * Ответы GitHub REST и GraphQL → типы ядра; строго, как у GitLab (`gitlab-map.ts`). Экспорт —
 * для таблицы записанных ответов CI (P30).
 */

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const login = (v: unknown): string | null => (isRecord(v) ? str(v.login) : null);

export function githubPr(v: unknown): ForgeMr | null {
  if (!isRecord(v) || !isRecord(v.head) || !isRecord(v.base)) return null;
  const iid = num(v.number);
  const createdAt = ms(v.created_at);
  const author = login(v.user);
  const title = str(v.title);
  const source = str(v.head.ref);
  const target = str(v.base.ref);
  if (iid === null || createdAt === null || author === null || title === null) return null;
  if (source === null || target === null) return null;
  const body = str(v.body) ?? '';
  const merged = v.merged_at !== null && v.merged_at !== undefined;
  return {
    id: String(v.id ?? iid),
    iid,
    url: str(v.html_url) ?? '',
    sourceBranch: source,
    targetBranch: target,
    headSha: str(v.head.sha),
    state: merged ? 'merged' : v.state === 'open' ? 'open' : 'closed',
    draft: v.draft === true,
    author,
    createdAt,
    bodyHash: mrBodyHash(title, body),
  };
}

export function githubPrList(v: unknown): ForgeMr[] | null {
  const list = asArray(v);
  if (!list) return null;
  const out = list.map(githubPr);
  return out.every((m): m is ForgeMr => m !== null) ? out : null;
}

export function githubMergeability(v: unknown): 'clean' | 'conflict' | 'checking' | null {
  if (!isRecord(v)) return null;
  if (v.mergeable === null || v.mergeable === undefined) return 'checking';
  if (v.mergeable === false || v.mergeable_state === 'dirty') return 'conflict';
  return 'clean';
}

/** Комментарий GraphQL (`databaseId`, `author.login`) или REST (`id`, `user.login`). */
export function githubComment(v: unknown): ForgeNote | null {
  if (!isRecord(v)) return null;
  const id = v.databaseId ?? v.id;
  const author = login(v.author) ?? login(v.user);
  const body = str(v.body);
  const createdAt = ms(v.createdAt ?? v.created_at);
  if (id === undefined || author === null || body === null || createdAt === null) return null;
  return { id: String(id), author, body, bodyHash: noteHash(body), createdAt };
}

/** Нити ревью из GraphQL `reviewThreads`. */
export function githubReviewThreads(v: unknown): ForgeThread[] | null {
  if (!isRecord(v) || !isRecord(v.data)) return null;
  const pr = isRecord(v.data.repository) ? v.data.repository.pullRequest : null;
  const threads =
    isRecord(pr) && isRecord(pr.reviewThreads) ? asArray(pr.reviewThreads.nodes) : null;
  if (!threads) return null;
  const out: ForgeThread[] = [];
  for (const t of threads) {
    if (!isRecord(t) || typeof t.id !== 'string' || !isRecord(t.comments)) return null;
    const notes = (asArray(t.comments.nodes) ?? [null]).map(githubComment);
    if (!notes.every((n): n is ForgeNote => n !== null)) return null;
    out.push({ id: t.id, resolvable: true, resolved: t.isResolved === true, notes });
  }
  return out;
}

/** Статус GitHub Actions (`status` + `conclusion`) → статус задания ядра. */
function jobStatus(status: unknown, conclusion: unknown): ForgeJobStatus {
  if (status === 'in_progress') return 'running';
  if (status === 'queued' || status === 'waiting' || status === 'pending' || status === 'requested')
    return 'pending';
  if (conclusion === 'success' || conclusion === 'neutral') return 'success';
  if (conclusion === 'cancelled') return 'canceled';
  if (conclusion === 'skipped') return 'skipped';
  return 'failed';
}

/**
 * Задание Actions: скрипт стартовал, если хоть один шаг после подготовки раннера («Set up job»,
 * номер 1) пошёл. Шагов нет или пошла только подготовка — скрипт не начинался (`infra`).
 */
export function githubJob(v: unknown): ForgeJob | null {
  if (!isRecord(v) || v.id === undefined || typeof v.name !== 'string') return null;
  const status = jobStatus(v.status, v.conclusion);
  const steps = asArray(v.steps) ?? [];
  const ran = steps.some(
    (s) =>
      isRecord(s) &&
      (num(s.number) ?? 0) > 1 &&
      s.status !== 'queued' &&
      s.status !== 'pending' &&
      s.conclusion !== 'skipped',
  );
  const startedAt = ms(v.started_at);
  return {
    id: String(v.id),
    name: v.name,
    status,
    failureReason: status === 'failed' ? (str(v.conclusion) ?? 'failure') : null,
    startedAt,
    scriptStarted: status === 'success' ? true : status === 'running' ? null : ran,
  };
}

export function githubRunStatus(v: Record<string, unknown>): ForgeJobStatus {
  return jobStatus(v.status, v.conclusion);
}

/** Событие репозитория → активность; прочие виды (звезда, форк) — `undefined`. */
export function githubActivity(v: unknown): ForgeActivity | null | undefined {
  if (!isRecord(v) || typeof v.type !== 'string') return null;
  const at = ms(v.created_at);
  const author = login(v.actor);
  if (at === null || author === null || v.id === undefined) return null;
  const payload = isRecord(v.payload) ? v.payload : {};
  const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
  // Комментарий к обычному issue (без `pull_request`) — не заметка к запросу на слияние.
  const issue = isRecord(payload.issue) && payload.issue.pull_request ? payload.issue : null;
  const iid = num(pr?.number) ?? num(issue?.number) ?? num(payload.number);
  const base = { id: String(v.id), author, at, ...(iid === null ? {} : { mrIid: iid }) };
  const comment = isRecord(payload.comment) ? payload.comment : null;
  const objectId = comment?.id === undefined ? {} : { objectId: String(comment.id) };
  let type: ForgeActivityType | undefined;
  switch (v.type) {
    case 'PushEvent':
      return {
        ...base,
        type: 'push',
        ref: String(payload.ref ?? '').replace(/^refs\/heads\//, ''),
      };
    case 'DeleteEvent':
      return { ...base, type: 'branch-delete', ref: String(payload.ref ?? '') };
    case 'PullRequestEvent':
      if (payload.action === 'opened') type = 'mr-open';
      else if (payload.action === 'edited') type = 'mr-update';
      else if (payload.action === 'closed' && pr?.merged === true) type = 'merge';
      return type ? { ...base, type } : undefined;
    case 'IssueCommentEvent':
    case 'PullRequestReviewCommentEvent':
      return { ...base, type: 'note', ...objectId };
    case 'PullRequestReviewEvent': {
      const review = isRecord(payload.review) ? payload.review : {};
      return review.state === 'approved'
        ? { ...base, type: 'approval' }
        : { ...base, type: 'note' };
    }
    default:
      return undefined;
  }
}
