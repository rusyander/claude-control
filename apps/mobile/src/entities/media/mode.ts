import type { MediaImagePlan } from '@agentdeck/contracts';
import type { Words } from './mode.types';

export interface ImageModeView {
  available: boolean;
  /** Почему заперт, словами. Пусто — план ещё не приехал или причины нет. */
  reasonText?: string;
  /** Кто и чем нарисует, с оговорками про растр и промпт режима. */
  sourceText?: string;
  /** Рисует агент разговора, а не панель: подсказка в поле обязана это сказать. */
  byAgent: boolean;
}

/**
 * Отказ словами от того, кто отказал, — рядом с нашей причиной, а не вместо неё.
 *
 * Та же дописка, что в панели (`withDetail` в `entities/Media/model/media-mode.ts`):
 * появляется у `gateway-failed`, и без неё человек читает «шлюз панели не
 * поднялся» без единого слова о том, чем именно. Нажимать ему нечего, а телефон
 * до ревью Т13 эту половину просто терял.
 */
function withDetail(text: string, plan: { reasonDetail?: string }): string {
  return plan.reasonDetail ? `${text} — ${plan.reasonDetail}` : text;
}

export function imageModeView(plan: MediaImagePlan | undefined, words: Words): ImageModeView {
  if (!plan) return { available: false, byAgent: false };
  if (!plan.available) {
    return plan.reason
      ? {
          available: false,
          reasonText: withDetail(words.blocked[plan.reason], plan),
          byAgent: false,
        }
      : { available: false, reasonText: words.imageBlocked, byAgent: false };
  }

  const byAgent = plan.source === 'agent';
  const parts = [byAgent ? words.sourceAgent : words.source(plan.title, plan.model)];
  if (plan.rasterReason) parts.push(withDetail(words.noRaster[plan.rasterReason], plan));
  if (!plan.promptSent) parts.push(words.promptSkipped);
  return { available: true, sourceText: parts.join(' · '), byAgent };
}
