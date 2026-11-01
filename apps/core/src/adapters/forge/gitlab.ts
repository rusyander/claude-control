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
  GITLAB_TIMEOUT_REASONS,
  gitlabActivity,
  gitlabJob,
  gitlabMergeability,
  gitlabMr,
  gitlabMrList,
  gitlabNote,
  gitlabThreads,
} from './gitlab-map.ts';
import { stripDraft } from './hash.ts';

/**
 * Переходник GitLab REST v4 (05 §Push and MR): MR, нити, CI и события проекта. Ни слияния, ни
 * одобрения — их нет по построению (P63): статический тест обходит ключи объекта и исходник.
 * Каждое чтение — факт; запись — значение или `unknown` (дошла ли — решает сверка outbox).
 */

const DAY_MS = 86_400_000;

/** Конец хвоста лога: последние `maxBytes` байт UTF-8, не символов. */
function tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString('utf8');
}

export function createGitlabPort(access: ForgeAccess): ForgePort {
  const site = access.project.baseUrl.replace(/\/+$/, '');
  const api = `${site}/api/v4`;
  const project = `/projects/${encodeURIComponent(access.project.ref)}`;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, accept?: 'text') =>
    forgeCall(access, api, {
      method,
      url,
      ...(body === undefined ? {} : { body }),
      ...(accept ? { accept } : {}),
    });

  async function jobs(pipelineId: string): Promise<Fact<ForgePipeline['jobs']>> {
    const where = `GET ${project}/pipelines/${pipelineId}/jobs`;
    const reply = await call('GET', `${project}/pipelines/${pipelineId}/jobs?per_page=100`);
    if (reply.kind !== 'ok') return { unknown: unknownReason(reply, where) };
    const list = asArray(reply.body);
    if (!list) return { unknown: `${where}: garbage (unexpected reply shape)` };
    const out: ForgePipeline['jobs'] = [];
    for (const raw of list) {
      // Таймаут: начался ли скрипт, скажет только лог задания (раздел `step_script`).
      const reason = isRecord(raw) ? raw.failure_reason : undefined;
      let trace: string | undefined;
      if (typeof reason === 'string' && GITLAB_TIMEOUT_REASONS.has(reason) && isRecord(raw)) {
        const log = await port.jobLogTail(String(raw.id), 200_000);
        if ('value' in log) trace = log.value;
      }
      const job = gitlabJob(raw, trace);
      if (!job) return { unknown: `${where}: garbage (unexpected reply shape)` };
      out.push(job);
    }
    return { value: out };
  }

  const port: ForgePort = {
    kind: 'gitlab',

    async whoAmI() {
      return readList(await call('GET', '/user'), 'GET /user', (v) =>
        isRecord(v) && v.id !== undefined && typeof v.username === 'string'
          ? { id: String(v.id), username: v.username }
          : null,
      );
    },

    async mrBySourceBranch(q) {
      const params = new URLSearchParams({
        source_branch: q.sourceBranch,
        author_username: q.author,
        created_after: new Date(q.createdAfter).toISOString(),
        state: 'all',
        order_by: 'created_at',
        per_page: '100',
      });
      const fact = readList(
        await call('GET', `${project}/merge_requests?${params}`),
        'GET merge_requests',
        gitlabMrList,
      );
      if (!('value' in fact)) return fact;
      // Фильтр сервера не доказательство: ветка, автор и время сверяются здесь же.
      const mine = fact.value
        .filter((m) => m.sourceBranch === q.sourceBranch && m.author === q.author)
        .filter((m) => m.createdAt >= q.createdAfter)
        .sort((a, b) => b.createdAt - a.createdAt);
      return mine[0] ? { value: mine[0] } : ABSENT;
    },

    async mr(iid) {
      return readById(
        await call('GET', `${project}/merge_requests/${iid}`),
        `GET merge_requests/${iid}`,
        gitlabMr,
      );
    },

    async createMr(input) {
      const title = input.draft ? `Draft: ${input.title}` : input.title;
      const reply = await call('POST', `${project}/merge_requests`, {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title,
        description: input.body,
        remove_source_branch: false,
      });
      return written(reply, 'POST merge_requests', gitlabMr);
    },

    async updateMr(iid, input) {
      const body: Record<string, string> = {};
      if (input.body !== undefined) body.description = input.body;
      if (input.title !== undefined) {
        // Заголовок без пометки снял бы черновик: пометка сохраняется по текущему MR.
        const current = await port.mr(iid);
        if (!('value' in current))
          return {
            unknown: 'unknown' in current ? current.unknown : `merge request ${iid} absent`,
          };
        body.title = current.value.draft ? `Draft: ${stripDraft(input.title)}` : input.title;
      }
      return written(
        await call('PUT', `${project}/merge_requests/${iid}`, body),
        `PUT merge_requests/${iid}`,
        gitlabMr,
      );
    },

    async threads(iid) {
      const url = `${project}/merge_requests/${iid}/discussions?per_page=100`;
      return readList(
        await call('GET', url),
        `GET merge_requests/${iid}/discussions`,
        gitlabThreads,
      );
    },

    async reply(iid, threadId, body) {
      const url = `${project}/merge_requests/${iid}/discussions/${encodeURIComponent(threadId)}/notes`;
      return written(
        await call('POST', url, { body }),
        `POST discussions/${threadId}/notes`,
        gitlabNote,
      );
    },

    async resolve(iid, threadId) {
      const url = `${project}/merge_requests/${iid}/discussions/${encodeURIComponent(threadId)}?resolved=true`;
      return written(await call('PUT', url), `PUT discussions/${threadId}`, (v) =>
        isRecord(v) ? true : null,
      );
    },

    async mergeability(iid) {
      return readById(
        await call('GET', `${project}/merge_requests/${iid}`),
        `GET merge_requests/${iid}`,
        gitlabMergeability,
      );
    },

    async pipelines(q) {
      const where = 'GET pipelines';
      const reply = await call(
        'GET',
        `${project}/pipelines?sha=${encodeURIComponent(q.sha)}&per_page=100`,
      );
      if (reply.kind !== 'ok') return { unknown: unknownReason(reply, where) };
      const list = asArray(reply.body);
      if (!list) return { unknown: `${where}: garbage (unexpected reply shape)` };
      const out: ForgePipeline[] = [];
      for (const raw of list) {
        const createdAt = isRecord(raw) ? ms(raw.created_at) : null;
        if (
          !isRecord(raw) ||
          raw.id === undefined ||
          typeof raw.sha !== 'string' ||
          createdAt === null
        )
          return { unknown: `${where}: garbage (unexpected reply shape)` };
        const got = await jobs(String(raw.id));
        if (!('value' in got)) return { unknown: 'unknown' in got ? got.unknown : where };
        const status = gitlabJob({
          id: raw.id,
          name: 'pipeline',
          status: raw.status,
          started_at: raw.created_at,
        });
        out.push({
          id: String(raw.id),
          sha: raw.sha,
          status: status?.status ?? 'skipped',
          createdAt,
          jobs: got.value,
        });
      }
      return { value: out };
    },

    async jobLogTail(jobId, maxBytes) {
      const reply = await call(
        'GET',
        `${project}/jobs/${encodeURIComponent(jobId)}/trace`,
        undefined,
        'text',
      );
      if (reply.kind === 'text') return { value: tail(reply.text, maxBytes) };
      if (reply.kind === 'status' && reply.status === 404) return ABSENT;
      return { unknown: unknownReason(reply, `GET jobs/${jobId}/trace`) };
    },

    async activitySince(q) {
      // `after` GitLab — сутки и строго после них: берём сутки раньше и режем по времени здесь.
      const day = new Date(q.since - DAY_MS).toISOString().slice(0, 10);
      const fact = await activityWindow('gitlab', q.since, async (n) => {
        const url = `${project}/events?after=${day}&sort=desc&per_page=${ACTIVITY_PAGE}&page=${n}`;
        return readList(await call('GET', url), 'GET events', (v) => {
          const list = asArray(v);
          if (!list) return null;
          const acts: ForgeActivity[] = [];
          for (const raw of list) {
            const one = gitlabActivity(raw);
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
