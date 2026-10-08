import type { ModelInfo } from '@agentdeck/contracts';

/** Сколько моделей показываем до нажатия «показать все». */
export const VISIBLE_MODELS = 12;

/**
 * Что реально видно в карточке: у OpenAI полсотни моделей, и вываливать их
 * целиком в настройки незачем — свежие сверху, остальные по кнопке.
 */
export function visibleModels(models: ModelInfo[], expanded: boolean): ModelInfo[] {
  return expanded ? models : models.slice(0, VISIBLE_MODELS);
}
