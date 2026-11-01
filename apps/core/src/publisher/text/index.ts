/**
 * `publisher/text` — сит исходящего текста (05 §Commit shape, P62) и соглашение о сообщениях.
 * Публикатор, ответы ревьюерам и трекер зовут одну `sieveText` (P80).
 */
export { sieveText } from './sieve.ts';
export {
  detectConvention,
  isConventional,
  languageOf,
  loadPublishTextConfig,
  matchesConvention,
  parsePublishTextConfig,
} from './convention.ts';
export { SIGN_OFF_SHARE } from './trailers.ts';
export type { PublishTextDecision, RefusedSpan, TextSieveContext } from './text.types.ts';
