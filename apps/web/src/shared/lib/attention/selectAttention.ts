import type { AttentionTone, AttentionReason } from './attention.types';

export interface AttentionView {
  /** Сколько неувиденных поводов зовут человека прямо сейчас. */
  count: number;
  /** Худший повод: упавший агент важнее ждущего. */
  tone?: AttentionTone;
}

/** Свести поводы к метке: считаются только неувиденные. */
export function selectAttention(
  reasons: readonly AttentionReason[],
  seen: ReadonlySet<string>,
): AttentionView {
  const unseen = reasons.filter((reason) => !seen.has(reason.key));
  if (unseen.length === 0) return { count: 0 };
  return {
    count: unseen.length,
    tone: unseen.some((reason) => reason.tone === 'danger') ? 'danger' : 'warning',
  };
}
