import {
  parseMrLink,
  REVIEW_LINK_REFUSALS,
  reviewLinkBodySchema,
  type ReviewLinkBody,
  type ReviewLinkRefused,
} from '@agentdeck/contracts/core/review-link';
import { newUuidv7 } from '@entities/CoreTask';
import type { EstimateAttempt } from './launch.types';
import type { ReviewLinkDraft } from './reviewLink.types';

/**
 * Модель формы «ревью MR по ссылке» (этап 10, F8): черновик → поля `POST /v1/review-link` (та же
 * схема, что разбирает ядро) и отказ ядра с кодом → текст на языке панели. Ссылку проверяет тот
 * же разбор, что у ядра (`parseMrLink`): не та форма не уходит, ядро ответило бы тем же отказом.
 */

export type ReviewLinkFields = ReviewLinkBody['fields'];
export type ReviewLinkProblem = 'url' | 'repo';

export function emptyReviewLinkDraft(): ReviewLinkDraft {
  return { url: '', repo: '' };
}

export function reviewLinkFieldsOf(
  draft: ReviewLinkDraft,
  language?: string,
): { ok: true; fields: ReviewLinkFields } | { ok: false; problems: ReviewLinkProblem[] } {
  const fields: ReviewLinkFields = {
    url: draft.url.trim(),
    repo: draft.repo.trim(),
    ...(language ? { lang: language.startsWith('en') ? ('en' as const) : ('ru' as const) } : {}),
  };
  const problems: ReviewLinkProblem[] = [];
  if (!parseMrLink(fields.url)) problems.push('url');
  if (!reviewLinkBodySchema.shape.fields.shape.repo.safeParse(fields.repo).success)
    problems.push('repo');
  return problems.length > 0 ? { ok: false, problems } : { ok: true, fields };
}

/**
 * Ключ повтора открытия ревью: прежний, пока поля те же и ответа не было (потерянный ответ и
 * повторное нажатие дают ту же задачу), иначе новый — как у оценки (`attemptFor`).
 */
export function reviewAttemptFor(
  prev: EstimateAttempt | null,
  fields: ReviewLinkFields,
  mint: () => string = newUuidv7,
): EstimateAttempt {
  const key = JSON.stringify(fields);
  if (prev && prev.key === key) return prev;
  return { cmdId: mint(), key };
}

const KNOWN = new Set<string>([...REVIEW_LINK_REFUSALS, 'estimate-refused']);

/**
 * Отказ открытия ревью (422 с кодом) из ошибки запроса; другой ответ — `null`, его разбирает общий
 * `failureOf` (сеть, полномочия, ядро не запущено).
 */
export function reviewLinkRefusalOf(error: unknown): ReviewLinkRefused | null {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  if (response?.status !== 422) return null;
  const data = (
    typeof response.data === 'object' && response.data !== null ? response.data : {}
  ) as { code?: unknown; problems?: unknown };
  if (typeof data.code !== 'string' || !KNOWN.has(data.code)) return null;
  return {
    code: data.code as ReviewLinkRefused['code'],
    problems: Array.isArray(data.problems) ? data.problems.map(String) : [],
  };
}
