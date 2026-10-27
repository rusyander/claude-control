import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TelegramConnectView } from '@agentdeck/contracts/telegram-answers';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { integrationKeys } from './keys';

/** Пока окно ждёт /start, состояние перечитывается часто: человек смотрит на экран. */
const WAITING_REFRESH_MS = 2_000;

const URL = '/integrations/telegram/connect';

/**
 * Подключение бота командой /start: окно на сервере, кандидат и подтверждение.
 * Опрос идёт, только пока окно ждёт — в остальных состояниях менять нечему.
 */
export function useTelegramConnect() {
  return useQuery({
    queryKey: integrationKeys.telegramConnect,
    queryFn: async () => {
      const { data } = await apiClient.get<TelegramConnectView>(URL);
      return data;
    },
    refetchInterval: (query) =>
      query.state.data?.state === 'waiting' ? WAITING_REFRESH_MS : false,
  });
}

function useConnectAction(path: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<TelegramConnectView>(`${URL}${path}`, {});
      return data;
    },
    onSuccess: (view) => {
      client.setQueryData(integrationKeys.telegramConnect, view);
      // Подтверждение записало чат уведомлений и владельца ответов: карточка
      // читает их из настроек, блок ответов — из своего запроса.
      if (view.state === 'confirmed') {
        void client.invalidateQueries({ queryKey: integrationKeys.list });
        void client.invalidateQueries({ queryKey: integrationKeys.telegramAnswers });
        void client.invalidateQueries({ queryKey: queryKeys.settings });
      }
    },
  });
}

export const useOpenTelegramConnect = () => useConnectAction('');
export const useConfirmTelegramConnect = () => useConnectAction('/confirm');
export const useCancelTelegramConnect = () => useConnectAction('/cancel');
