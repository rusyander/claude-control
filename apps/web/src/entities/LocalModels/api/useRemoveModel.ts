import type { LocalRemoveResult } from '@agentdeck/contracts/local-models';
import { useLocalAction } from './useLocalAction';
import { apiClient } from '@shared/api/client';

/** Удалить скачанное: с `quant` — одно квантование, без него — модель целиком. */
export const useRemoveModel = () =>
  useLocalAction<{ tag: string; quant?: string }, LocalRemoveResult>(async ({ tag, quant }) => {
    const { data } = await apiClient.delete<LocalRemoveResult>(
      `/local-models/models/${encodeURIComponent(tag)}`,
      quant ? { params: { quant } } : undefined,
    );
    return data;
  });
