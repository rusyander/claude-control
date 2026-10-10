import type { ForgeAccess } from '../forge.ts';
import {
  forgeAccessForUrl,
  forgeGet,
  forgeGraphql,
  forgeProjectRef,
  parseMergeRequestUrl,
} from '../forge.ts';
import type { MrReview } from '../mr-review/mr-review.types.ts';

/**
 * Только СОСТОЯНИЕ MR — открыт, влит, закрыт — для хаба (владелец 06.10.2026).
 *
 * Полное чтение (`mr-review.ts`) тянет ветки обсуждения постранично и конвейер;
 * чтобы перекрасить карточку, это лишнее. Здесь — один запрос на проект: у
 * GitLab список `merge_requests?iids[]=…` отдаёт все MR плана разом, у GitHub —
 * один запрос GraphQL с псевдонимом на каждый PR. Четыре группы плана в одном
 * репозитории — один запрос, а не четыре полных чтения.
 *
 * Ответ — карта «ссылка → состояние». Ссылки, которых в ней нет, — неизвестны:
 * фордж не тот, проект не прочитался или MR в ответе не оказалось. Ошибка
 * проекта не роняет остальные — она уходит в `failed`.
 */

export type MrState = MrReview['state'];

export interface MrStates {
  states: Map<string, MrState>;
  failed: unknown[];
}

/** У GitLab `per_page` не больше 100 — больше MR в плане не бывает, но держим. */
const GITLAB_PAGE = 100;

interface Batch {
  access: ForgeAccess;
  /** Номер MR → ссылки на него (одну и ту же ссылку пишут по-разному). */
  numbers: Map<number, string[]>;
}

function gitlabState(state: string | undefined): MrState {
  if (state === 'merged') return 'merged';
  if (state === 'closed' || state === 'locked') return 'closed';
  return 'open';
}

function githubState(state: string | undefined): MrState {
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return 'open';
}

/** Ключ на ссылку: строкой — один на все, функцией — свой у каждого форджа. */
export type MrTokenSource = string | ((url: string) => string | undefined);

function batchesOf(urls: readonly string[], token: MrTokenSource): Batch[] {
  const batches = new Map<string, Batch>();
  for (const url of urls) {
    const ref = parseMergeRequestUrl(url);
    const key = typeof token === 'string' ? token : token(url);
    // Фордж этой ссылки не подключён — читать её нечем, остальные читаются.
    if (!key) continue;
    const access = forgeAccessForUrl(url, key);
    if (!ref || !access) continue;
    const id = `${access.kind} ${access.api} ${access.repo}`;
    const batch = batches.get(id) ?? { access, numbers: new Map<number, string[]>() };
    batch.numbers.set(ref.number, [...(batch.numbers.get(ref.number) ?? []), url]);
    batches.set(id, batch);
  }
  return [...batches.values()];
}

async function readGitlab(batch: Batch): Promise<Map<number, MrState>> {
  const found = new Map<number, MrState>();
  const numbers = [...batch.numbers.keys()];
  for (let at = 0; at < numbers.length; at += GITLAB_PAGE) {
    const iids = numbers
      .slice(at, at + GITLAB_PAGE)
      .map((number) => `iids[]=${number}`)
      .join('&');
    const list = await forgeGet<{ iid?: number; state?: string }[]>(
      batch.access,
      `/projects/${forgeProjectRef(batch.access)}/merge_requests?${iids}&state=all&per_page=${GITLAB_PAGE}`,
    );
    for (const mr of list ?? []) {
      if (typeof mr.iid === 'number') found.set(mr.iid, gitlabState(mr.state));
    }
  }
  return found;
}

async function readGithub(batch: Batch): Promise<Map<number, MrState>> {
  const [owner, name] = batch.access.repo.split('/');
  const numbers = [...batch.numbers.keys()];
  // Номера — целые из разобранной ссылки, в текст запроса они идут как есть;
  // владелец и имя — переменными, а не вставкой строки.
  const fields = numbers
    .map((number) => `p${number}: pullRequest(number: ${number}) { state }`)
    .join(' ');
  const data = await forgeGraphql<{
    repository?: Record<string, { state?: string } | null> | null;
  }>(
    batch.access,
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
    { owner, name },
  );
  const found = new Map<number, MrState>();
  for (const number of numbers) {
    const pr = data.repository?.[`p${number}`];
    if (pr?.state) found.set(number, githubState(pr.state));
  }
  return found;
}

export async function readMergeRequestStates(
  urls: readonly string[],
  token: MrTokenSource,
): Promise<MrStates> {
  const states = new Map<string, MrState>();
  const failed: unknown[] = [];
  for (const batch of batchesOf(urls, token)) {
    try {
      const found =
        batch.access.kind === 'github' ? await readGithub(batch) : await readGitlab(batch);
      for (const [number, state] of found) {
        for (const url of batch.numbers.get(number) ?? []) states.set(url, state);
      }
    } catch (error) {
      failed.push(error);
    }
  }
  return { states, failed };
}
