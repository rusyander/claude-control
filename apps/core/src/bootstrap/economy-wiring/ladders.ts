import type { AdapterRegistry } from '../../adapters/index.ts';
import type { TierLadder } from '../../economy/tier.types.ts';

/**
 * Лестницы уровня шага по id переходника — одна на загрузку, из лестницы каждого переходника
 * (её строит он сам по фактам запуска CLI, P108). Её читают суд `tier` шага (понижение механики,
 * подъём усилия плана, ревьюер не слабее автора) и ранг модели правки человека (`set-model`).
 * Переходник без лестницы в записи отсутствует — суды называют «ранг неизвестен».
 */
export function laddersOf(
  adapters: Pick<AdapterRegistry, 'all'>,
): Readonly<Record<string, TierLadder>> {
  const out: Record<string, TierLadder> = {};
  for (const adapter of adapters.all()) if (adapter.ladder) out[adapter.id] = adapter.ladder;
  return out;
}
