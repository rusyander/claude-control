import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  TelegramAnswersSave,
  TelegramAnswersView,
} from '@agentdeck/contracts/telegram-answers';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';

/** Как часто обновлять состояние опроса, пока блок открыт. */
const STATUS_REFRESH_MS = 10_000;

/**
 * Ответы из Telegram: настройка и состояние опроса бота. Токен сервер не
 * отдаёт — только маску; состояние живое (опрос мог упереться в 409 или вебхук),
 * поэтому перечитывается, пока блок на экране.
 */
export function useTelegramAnswers() {
  return useQuery({
    queryKey: integrationKeys.telegramAnswers,
    queryFn: async () => {
      const { data } = await apiClient.get<TelegramAnswersView>('/integrations/telegram/answers');
      return data;
    },
    refetchInterval: STATUS_REFRESH_MS,
  });
}

export function useSaveTelegramAnswers() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: TelegramAnswersSave) => {
      const { data } = await apiClient.put<TelegramAnswersView>(
        '/integrations/telegram/answers',
        body,
      );
      return data;
    },
    onSuccess: (view) => client.setQueryData(integrationKeys.telegramAnswers, view),
    meta: { successMessage: 'telegramAnswers.saved' },
  });
}

export function useRestartTelegramAnswers() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<TelegramAnswersView>(
        '/integrations/telegram/answers/restart',
        {},
      );
      return data;
    },
    onSuccess: (view) => client.setQueryData(integrationKeys.telegramAnswers, view),
  });
}
