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

export function imageModeView(plan: MediaImagePlan | undefined, words: Words): ImageModeView {
  if (!plan) return { available: false, byAgent: false };
  if (!plan.available) {
    return plan.reason
      ? {
          available: false,
          reasonText: words.blocked[plan.reason],
          byAgent: false,
        }
      : { available: false, reasonText: words.imageBlocked, byAgent: false };
  }

  const byAgent = plan.source === 'agent';
  const parts = [byAgent ? words.sourceAgent : words.source(plan.title, plan.model)];
  if (plan.rasterReason) parts.push(words.noRaster[plan.rasterReason]);
  if (!plan.promptSent) parts.push(words.promptSkipped);
  return { available: true, sourceText: parts.join(' · '), byAgent };
}
