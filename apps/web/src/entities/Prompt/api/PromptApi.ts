import { useQuery } from '@tanstack/react-query';
import type { PromptSummary } from '@agentdeck/contracts/prompts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Каталог промптов приложения.
 *
 * Список и карточка — два разных запроса намеренно: в списке пять строк с
 * размером и состоянием, а в карточке два текста по несколько килобайт, и
 * тянуть их ради экрана со списком незачем. Открытая карточка своим запросом и
 * обновляется.
 */

async function getPrompts(): Promise<PromptSummary[]> {
  const { data } = await apiClient.get<{ items: PromptSummary[] }>('/prompts');
  return data.items;
}

export function usePrompts() {
  return useQuery({ queryKey: queryKeys.prompts, queryFn: getPrompts });
}
