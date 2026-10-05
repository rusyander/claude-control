import { forgeAccessForUrl, forgeGet, forgeProjectRef, parseMergeRequestUrl } from './forge.ts';
import { readGithubReview } from './mr-review-github.ts';
import type {
  MrReview,
  MrReviewNote,
  MrReviewPipeline,
  MrReviewThread,
} from './mr-review.types.ts';

/**
 * Что происходит с MR группы после «готово» (WP1j; журнал 104, 114): ветки
 * обсуждения ревьюеров и исход конвейера. Только чтение, по ссылке MR и токену
 * форджа, — наблюдатель (`domains/chat/mr-watch.ts`) решает, что из этого
 * передать группе.
 *
 * GitLab — REST v4; GitHub — GraphQL (`mr-review-github.ts`): «ветка решена»
 * у него видна только там (`reviewThreads.isResolved`), а исход проверок —
 * сводным `statusCheckRollup` головы PR.
 */

export type { MrReview, MrReviewNote, MrReviewPipeline, MrReviewThread };

/** Сколько страниц обсуждений читаем: сотня на странице, тысяча веток — с запасом. */
const MAX_DISCUSSION_PAGES = 10;
const PER_PAGE = 100;

/**
 * Служебные учётные записи GitLab: токены проекта и группы (`project_12_bot_…`,
 * `group_3_bot`), `ghost`, `*-bot`, `[bot]` у GitHub. Поле `bot` отдают не все
 * версии GitLab, поэтому смотрим и на имя.
 */
const BOT_NAME = /^(project|group)_\d+_bot|(^|[-_.])bot($|[-_.\d])|\[bot\]$|^ghost$/i;

export function isBotName(username: string): boolean {
  return BOT_NAME.test(username);
}

interface GlUser {
  username?: string;
  bot?: boolean;
}

interface GlNote {
  id: number;
  body?: string;
  author?: GlUser;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  created_at?: string;
  position?: { new_path?: string; old_path?: string; new_line?: number; old_line?: number };
}

interface GlDiscussion {
  id: string;
  notes?: GlNote[];
}

interface GlMergeRequest {
  state?: string;
  description?: string | null;
  has_conflicts?: boolean;
  author?: GlUser;
  head_pipeline?: { id?: number; status?: string; web_url?: string } | null;
}

/** Ветка обсуждения GitLab глазами панели. Одна служебная — `undefined`. */
export function toThread(discussion: GlDiscussion): MrReviewThread | undefined {
  const notes = (discussion.notes ?? []).filter((note) => !note.system);
  if (notes.length === 0) return undefined;
  const resolvable = notes.filter((note) => note.resolvable);
  const first = notes[0]!;
  const path = first.position?.new_path ?? first.position?.old_path;
  const line = first.position?.new_line ?? first.position?.old_line;
  return {
    id: discussion.id,
    resolvable: resolvable.length > 0,
    // Ветка решена, когда решены все её реплики, которые вообще решаются.
    resolved: resolvable.length > 0 && resolvable.every((note) => note.resolved),
    notes: notes.map((note) => {
      const author = note.author?.username ?? '';
      return {
        id: String(note.id),
        author,
        ...(note.author?.bot || isBotName(author) ? { bot: true } : {}),
        body: note.body ?? '',
        ...(note.created_at ? { createdAt: note.created_at } : {}),
      };
    }),
    ...(path ? { path } : {}),
    ...(typeof line === 'number' ? { line } : {}),
  };
}

function toState(state: string | undefined): MrReview['state'] {
  if (state === 'merged') return 'merged';
  if (state === 'closed' || state === 'locked') return 'closed';
  return 'open';
}

/**
 * Прочитать MR по ссылке: состояние, автор, ветки обсуждения, конвейер головы.
 * `undefined` — ссылка не про MR или фордж, который панель так читать не умеет.
 * Отказ сети или форджа бросается: «сейчас не вышло» — не «нечего читать».
 */
export async function readMergeRequestReview(
  url: string,
  token: string,
): Promise<MrReview | undefined> {
  const ref = parseMergeRequestUrl(url);
  const access = forgeAccessForUrl(url, token);
  if (!ref || !access) return undefined;
  if (access.kind === 'github') return readGithubReview(access, ref, url);
  const base = `/projects/${forgeProjectRef(access)}/merge_requests/${ref.number}`;

  const mr = await forgeGet<GlMergeRequest>(access, base);
  const threads: MrReviewThread[] = [];
  for (let page = 1; page <= MAX_DISCUSSION_PAGES; page += 1) {
    const discussions = await forgeGet<GlDiscussion[]>(
      access,
      `${base}/discussions?per_page=${PER_PAGE}&page=${page}`,
    );
    for (const discussion of discussions ?? []) {
      const thread = toThread(discussion);
      if (thread) threads.push(thread);
    }
    if (!discussions || discussions.length < PER_PAGE) break;
  }

  const pipeline = mr.head_pipeline;
  return {
    state: toState(mr.state),
    ...(mr.author?.username ? { author: mr.author.username } : {}),
    description: mr.description ?? '',
    ...(typeof mr.has_conflicts === 'boolean' ? { conflicts: mr.has_conflicts } : {}),
    threads,
    ...(pipeline?.id !== undefined && pipeline.status
      ? {
          pipeline: {
            id: String(pipeline.id),
            status: pipeline.status,
            ...(pipeline.web_url ? { url: pipeline.web_url } : {}),
          },
        }
      : {}),
  };
}
