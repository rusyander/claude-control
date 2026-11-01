import type { TextKind } from '@agentdeck/contracts/core/publish';
import {
  companyNameSpans,
  localPathSpans,
  processWordSpans,
  recordIdSpans,
  secretSpans,
  uuidv7Spans,
} from './rules.ts';
import { findTrailers, keepsSignOff, stripTrailers } from './trailers.ts';
import type { PublishTextDecision, RefusedSpan, TextSieveContext } from './text.types.ts';

/**
 * `publisher/text` (05 §Commit shape, P62): ОДИН сит над каждым исходящим текстом — сообщение
 * коммита, заголовок и описание MR, ответ в треде, комментарий трекера. Вердикт зависит только от
 * вида текста, самого текста и контекста, никогда от того, кто зовёт (P80): коммит, описание MR,
 * `step_done.replies` и трекер получают одно и то же решение на одном входе.
 *
 * Подпись авторства снимается молча (`stripped`); всё остальное — отказ с местами: текст правит
 * шаг или публикатор пересобирает сообщение, сит сам смысл не переписывает. Чистый текст уходит
 * байт в байт.
 */
export function sieveText(
  kind: TextKind,
  text: string,
  ctx: TextSieveContext,
): PublishTextDecision {
  const trailers = findTrailers(text, keepsSignOff(kind, ctx));
  // Отказ внутри снимаемой строки не в счёт: `Claude-Session: <id>` уходит целиком вместе с id.
  const inTrailer = (span: RefusedSpan) =>
    trailers.some((t) => span.start >= t.start && span.end <= t.end);
  const spans = [
    ...uuidv7Spans(text),
    ...recordIdSpans(text),
    ...localPathSpans(text, ctx),
    ...companyNameSpans(text, ctx),
    ...processWordSpans(text),
    ...secretSpans(text),
  ]
    .filter((span) => !inTrailer(span))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.rule.localeCompare(b.rule));
  if (spans.length > 0) return { kind: 'refused', spans };
  if (trailers.length === 0) return { kind: 'pass', text };
  return {
    kind: 'stripped',
    text: stripTrailers(text, trailers),
    removed: trailers.map((t) => ({ rule: 'trailer', line: t.line })),
  };
}
