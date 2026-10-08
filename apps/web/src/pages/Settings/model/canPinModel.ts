import type { ModelCatalogResponse, ModelInfo } from '@agentdeck/contracts';

/**
 * Можно ли назначить модель дефолтом.
 *
 * Пропавшую у контура — нельзя: она осталась на экране как объяснение («была,
 * больше нет»), а не как рабочий выбор, и контур такой запрос уже не примет.
 * Дефолт чата — настройка Claude, поэтому чужой вендор туда тоже не годится:
 * чат просто не запустится с такой моделью.
 */
export function canPinModel(catalog: ModelCatalogResponse, model: ModelInfo): boolean {
  if (model.retired) return false;
  return catalog.source === 'platform' ? true : catalog.provider === 'claude';
}
