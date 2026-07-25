import type { ModelInfo } from '@claude-control/contracts';

/** Сколько моделей показываем до нажатия «показать все». */
export const VISIBLE_MODELS = 12;

/**
 * Что реально видно в карточке: у OpenAI полсотни моделей, и вываливать их
 * целиком в настройки незачем — свежие сверху, остальные по кнопке.
 */
export function visibleModels(models: ModelInfo[], expanded: boolean): ModelInfo[] {
  return expanded ? models : models.slice(0, VISIBLE_MODELS);
}

/**
 * Окно контекста человеческим числом: `1000000` → `1M`, `200000` → `200K`.
 * Пусто, если источник лимита не знает, — выдумывать нечего.
 */
export function formatContext(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1_000_000) return `${round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${round(tokens / 1_000)}K`;
  return String(tokens);
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
