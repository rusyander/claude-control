import { useQuery } from '@tanstack/react-query';
import type { RunInputsResponse } from '@agentdeck/contracts/run-input';
import { chatKeys } from './ChatApi.constants';
import { apiClient } from '@shared/api/client';

/**
 * «Что получил агент» (U8): дословные входы последних прогонов разговора.
 * Читается только по открытию окна — входы бывают в сотни килобайт, и тянуть
 * их на каждую карточку хаба незачем. Ключ — как у связи конвейера:
 * `sessionId` у Claude, `<провайдер>:<id>` у чужого CLI.
 */
export function useRunInputs(key: string, enabled: boolean) {
  return useQuery({
    queryKey: chatKeys.received(key),
    queryFn: async () => {
      const { data } = await apiClient.get<RunInputsResponse>(
        `/chat/${encodeURIComponent(key)}/received`,
      );
      return data;
    },
    enabled: enabled && Boolean(key),
  });
}
