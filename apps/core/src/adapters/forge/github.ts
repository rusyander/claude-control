import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeActivity, ForgePipeline, ForgePort } from '@agentdeck/contracts/core/forge';
import { ABSENT } from '../../lib/facts/read-fact.ts';
import { ACTIVITY_PAGE, activityWindow } from './activity.ts';
import type { ForgeAccess } from './forge.types.ts';
import {
  asArray,
  byTime,
  forgeCall,
  isRecord,
  ms,
  readById,
  readList,
  unknownReason,
  written,
} from './http.ts';
import {
  githubActivity,
  githubComment,
  githubJob,
  githubMergeability,
  githubPr,
  githubPrList,
  githubReviewThreads,
  githubRunStatus,
} from './github-map.ts';

/**
 * Переходник GitHub: REST для запросов на слияние, проверок и событий, GraphQL — для нитей ревью
 * (ответ и разрешение есть только там). Облако — `api.github.com` и `/graphql`; своя
 * инсталляция — `<сайт>/api/v3` и `<сайт>/api/graphql`. Ни слияния, ни одобрения (P63).
 * Ошибки GraphQL приходят кодом 200 в `errors` — это `unknown`, не значение.
 */

const CLOUD = 'https://github.com';

const THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId body createdAt author{login}}}}}}}}';
const REPLY_MUTATION =
  'mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body})' +
  '{comment{databaseId body createdAt author{login}}}}';
const RESOLVE_MUTATION =
  'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}';

function tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString('utf8');
}

/** Ответ GraphQL без `errors` и с данными — иначе `null` (разбор скажет `garbage`/`unknown`). */
function graphData(v: unknown): Record<string, unknown> | null {
  if (!isRecord(v) || (Array.isArray(v.errors) && v.errors.length > 0)) return null;
  return isRecord(v.data) ? v.data : null;
}

export function createGithubPort(access: ForgeAccess): ForgePort {
  const site = access.project.baseUrl.replace(/\/+$/, '') || CLOUD;
  const cloud = site === CLOUD;
  const api = cloud ? 'https://api.github.com' : `${site}/api/v3`;
  const graphql = cloud ? 'https://api.github.com/graphql' : `${site}/api/graphql`;
  const [owner = '', name = ''] = access.project.ref.split('/');
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, accept?: 'text') =>
    forgeCall(access, api, {
      method,
      url,
      ...(body === undefined ? {} : { body }),
      ...(accept ? { accept } : {}),
    });
  const graph = (query: string, variables: Record<string, unknown>) =>
    forgeCall(access, api, { method: 'POST', url: graphql, body: { query, variables } });

  /** GraphQL с ошибкой в `errors` — исход не узнан, причина названа. */
  async function graphWrite<T>(
    query: string,
    variables: Record<string, unknown>,
    where: string,
    pick: (d: Record<string, unknown>) => T | null,
  ) {
    const reply = await graph(query, variables);
    if (
      reply.kind === 'ok' &&
      isRecord(reply.body) &&
      Array.isArray(reply.body.errors) &&
      reply.body.errors.length > 0
    ) {
      const first = reply.body.errors[0];
      const message =
        isRecord(first) && typeof first.message === 'string' ? first.message : 'error';
      return { unknown: `${where}: graphql ${message.slice(0, 160)}` };
    }
    return written(reply, where, (v) => {
      const data = graphData(v);
      return data ? pick(data) : null;
    });
  }

  const port: ForgePort = {
    kind: 'github',

    async whoAmI() {
      return readList(await call('GET', '/user'), 'GET /user', (v) =>
        isRecord(v) && v.id !== undefined && typeof v.login === 'string'
          ? { id: String(v.id), username: v.login }
          : null,
      );
    },

    async mrBySourceBranch(q) {
      const head = encodeURIComponent(`${owner}:${q.sourceBranch}`);
      const fact = readList(
        await call('GET', `${repo}/pulls?head=${head}&state=all&per_page=100`),
        'GET pulls',
        githubPrList,
      );
      if (!('value' in fact)) return fact;
      const mine = fact.value
        .filter((m) => m.sourceBranch === q.sourceBranch && m.author === q.author)
        .filter((m) => m.createdAt >= q.createdAfter)
        .sort((a, b) => b.createdAt - a.createdAt);
      return mine[0] ? { value: mine[0] } : ABSENT;
    },

    async mr(iid) {
      return readById(await call('GET', `${repo}/pulls/${iid}`), `GET pulls/${iid}`, githubPr);
    },

    async createMr(input) {
      const reply = await call('POST', `${repo}/pulls`, {
        head: input.sourceBranch,
        base: input.targetBranch,
        title: input.title,
        body: input.body,
        draft: input.draft,
      });
      return written(reply, 'POST pulls', githubPr);
    },

    async updateMr(iid, input) {
      const body: Record<string, string> = {};
      if (input.title !== undefined) body.title = input.title;
      if (input.body !== undefined) body.body = input.body;
      return written(
        await call('PATCH', `${repo}/pulls/${iid}`, body),
        `PATCH pulls/${iid}`,
        githubPr,
      );
    },

    async threads(iid) {
      return readList(
        await graph(THREADS_QUERY, { owner, name, number: iid }),
        `graphql reviewThreads ${iid}`,
        githubReviewThreads,
      );
    },

    async reply(_iid, threadId, body) {
      return graphWrite(REPLY_MUTATION, { threadId, body }, `graphql reply ${threadId}`, (d) =>
        isRecord(d.addPullRequestReviewThreadReply)
          ? githubComment(d.addPullRequestReviewThreadReply.comment)
          : null,
      );
    },

    async resolve(_iid, threadId) {
      return graphWrite(RESOLVE_MUTATION, { threadId }, `graphql resolve ${threadId}`, (d) =>
        isRecord(d.resolveReviewThread) ? true : null,
      );
    },

    async mergeability(iid) {
      return readById(
        await call('GET', `${repo}/pulls/${iid}`),
        `GET pulls/${iid}`,
        githubMergeability,
      );
    },

    async pipelines(q) {
      const where = 'GET actions/runs';
      const reply = await call(
        'GET',
        `${repo}/actions/runs?head_sha=${encodeURIComponent(q.sha)}&per_page=100`,
      );
      if (reply.kind !== 'ok') return { unknown: unknownReason(reply, where) };
      const runs = isRecord(reply.body) ? asArray(reply.body.workflow_runs) : null;
      if (!runs) return { unknown: `${where}: garbage (unexpected reply shape)` };
      const out: ForgePipeline[] = [];
      for (const run of runs) {
        const createdAt = isRecord(run) ? ms(run.created_at) : null;
        if (
          !isRecord(run) ||
          run.id === undefined ||
          typeof run.head_sha !== 'string' ||
          createdAt === null
        )
          return { unknown: `${where}: garbage (unexpected reply shape)` };
        const jobs: Fact<ForgePipeline['jobs']> = readList(
          await call('GET', `${repo}/actions/runs/${run.id}/jobs?per_page=100`),
          `GET runs/${run.id}/jobs`,
          (v) => {
            const list = isRecord(v) ? asArray(v.jobs) : null;
            const mapped = list?.map(githubJob) ?? null;
            return mapped && mapped.every((j) => j !== null)
              ? (mapped as ForgePipeline['jobs'])
              : null;
          },
        );
        if (!('value' in jobs)) return { unknown: 'unknown' in jobs ? jobs.unknown : where };
        out.push({
          id: String(run.id),
          sha: run.head_sha,
          status: githubRunStatus(run),
          createdAt,
          jobs: jobs.value,
        });
      }
      return { value: out };
    },

    async jobLogTail(jobId, maxBytes) {
      const reply = await call(
        'GET',
        `${repo}/actions/jobs/${encodeURIComponent(jobId)}/logs`,
        undefined,
        'text',
      );
      if (reply.kind === 'text') return { value: tail(reply.text, maxBytes) };
      if (reply.kind === 'status' && reply.status === 404) return ABSENT;
      return { unknown: unknownReason(reply, `GET jobs/${jobId}/logs`) };
    },

    async activitySince(q) {
      const fact = await activityWindow('github', q.since, async (n) => {
        const url = `${repo}/events?per_page=${ACTIVITY_PAGE}&page=${n}`;
        return readList(await call('GET', url), 'GET events', (v) => {
          const list = asArray(v);
          if (!list) return null;
          const acts: ForgeActivity[] = [];
          for (const raw of list) {
            const one = githubActivity(raw);
            if (one === null) return null;
            if (one) acts.push(one);
          }
          return { rows: list.length, acts };
        });
      });
      if (!('value' in fact)) return fact;
      const refs = new Set(q.refs);
      const iids = new Set(q.mrIids);
      return {
        value: fact.value
          .filter((a) => a.at >= q.since)
          .filter(
            (a) =>
              (a.ref !== undefined && refs.has(a.ref)) ||
              (a.mrIid !== undefined && iids.has(a.mrIid)),
          )
          .sort(byTime),
      };
    },
  };
  return port;
}
