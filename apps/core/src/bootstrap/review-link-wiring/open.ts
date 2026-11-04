import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import {
  parseMrLink,
  type ReviewLinkBody,
  type ReviewLinkRefusal,
} from '@agentdeck/contracts/core/review-link';
import { openReviewTask, type SplitEnv } from '../../conductor/estimate/index.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import type { ForgeAccess } from '../publish-wiring/attempt.ts';
import { repoServerOf } from '../publish-wiring/unit-view.ts';

/**
 * Открытие ревью MR по ссылке (этап 10, F8): ссылка → проект по remote репозитория → MR у форжа
 * → задача `review-link@1` (`openReviewTask`). Каждый отказ — с кодом и причиной, задачи нет:
 * догадка по чужой ссылке открыла бы ревью не того MR, а пуш — в чужой проект.
 */

export interface ReviewLinkOpenDeps {
  registry: TaskRegistry;
  env: SplitEnv;
  git?: GitOptions;
  /** Форж по адресу пуша; `null` — форж без API (только пуш и ссылка). */
  forgeFor(url: string): ForgeAccess | null;
}

export type ReviewLinkOpenOutcome =
  | { status: 200 | 202; reply: EstimateReply }
  | { status: 422; code: ReviewLinkRefusal | 'estimate-refused'; problems: string[] };

const refused = (code: ReviewLinkRefusal, problem: string): ReviewLinkOpenOutcome => ({
  status: 422,
  code,
  problems: [problem],
});

/** Хост и путь проекта без регистра и `.git`: так их пишут и ссылка, и адрес MR у форжа. */
const same = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/\.git$/, '') === b.toLowerCase().replace(/\.git$/, '');

export async function openReviewLink(
  body: ReviewLinkBody,
  deps: ReviewLinkOpenDeps,
): Promise<ReviewLinkOpenOutcome> {
  const { url, repo, lang } = body.fields;
  const link = parseMrLink(url);
  if (!link) return refused('review_link_unparsed', `not a GitLab MR or GitHub PR link: ${url}`);
  const server = await repoServerOf(repo, '', deps.git ?? {});
  if (!('value' in server)) return refused('review_link_unread', `${repo}: ${server.unknown}`);
  const access = deps.forgeFor(server.value.url);
  if (!access || access.port.kind === 'generic')
    return refused(
      'review_link_forge_unsupported',
      `${server.value.url}: no forge API for this remote (push + link only)`,
    );
  if (access.port.kind !== link.forge)
    return refused(
      'review_link_foreign_repo',
      `the link is a ${link.forge} MR, the repository remote is on ${access.port.kind}`,
    );
  const mr = await access.port.mr(link.iid);
  if ('unknown' in mr) return refused('review_link_unread', `MR !${link.iid}: ${mr.unknown}`);
  if ('absent' in mr)
    return refused('review_link_foreign_repo', `MR !${link.iid} is not in ${server.value.url}`);
  // Тот же номер в проекте remote — ещё не тот MR: сверяется адрес, который вернул форж.
  const got = parseMrLink(mr.value.url);
  if (!got || !same(got.host, link.host) || !same(got.project, link.project))
    return refused(
      'review_link_foreign_repo',
      `MR !${link.iid} of ${server.value.url} is ${mr.value.url}, not ${url}`,
    );
  if (mr.value.state !== 'open')
    return refused('review_link_closed', `MR !${link.iid} is ${mr.value.state}`);
  const outcome = await openReviewTask(
    {
      cmdId: body.cmdId,
      repo,
      remote: server.value.remote,
      forge: link.forge,
      mr: { ...mr.value, title: `${mr.value.sourceBranch} → ${mr.value.targetBranch}` },
      ...(lang ? { lang } : {}),
    },
    deps.registry,
    deps.env,
    deps.git ?? {},
  );
  return outcome.status === 422
    ? { status: 422, code: 'estimate-refused', problems: outcome.problems }
    : outcome;
}
