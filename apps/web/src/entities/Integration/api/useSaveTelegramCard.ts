import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IntegrationStatus, TelegramSettings } from '@agentdeck/contracts';
import type {
  TelegramAnswersSave,
  TelegramAnswersView,
} from '@agentdeck/contracts/telegram-answers';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { integrationKeys } from './keys';

/** Что уходит одним «Сохранить» карточки Telegram. */
export interface TelegramCardSave {
  notify: TelegramSettings;
  /** Новый токен бота уведомлений; нет — прежний остаётся. */
  notifyToken?: string;
  answers: TelegramAnswersSave;
}

/** Итог сохранения: какая из двух настроек не записалась. */
export type TelegramCardSaveResult =
  { ok: true } | { ok: false; failed: 'notify' | 'answers'; error: unknown };

/**
 * Одно «Сохранить» карточки Telegram — два маршрута по очереди: настройка
 * уведомлений, затем ответов. Последовательность и что говорить при сбое
 * решает вызывающий (`sequence`): сбой — значение, а не исключение, и общий
 * тост ошибки не дублирует строку карточки.
 */
export function useSaveTelegramCard(
  sequence: (api: {
    saveNotify: () => Promise<unknown>;
    saveAnswers: () => Promise<unknown>;
  }) => Promise<TelegramCardSaveResult>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: TelegramCardSave) =>
      sequence({
        saveNotify: () =>
          apiClient.put<IntegrationStatus>('/integrations/telegram', {
            settings: body.notify,
            ...(body.notifyToken ? { token: body.notifyToken } : {}),
          }),
        saveAnswers: () =>
          apiClient.put<TelegramAnswersView>('/integrations/telegram/answers', body.answers),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: integrationKeys.root });
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}
