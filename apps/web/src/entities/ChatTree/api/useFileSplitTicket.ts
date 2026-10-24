import { apiClient } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

/**
 * Тело «Завести тикет»: ключ предложения, описание и язык интерфейса — на нём
 * сервер пишет комментарий, если задача про то же уже открыта.
 */
export interface FileSplitTicketInput {
  parentChatId: string;
  key: string;
  description: string;
  lang: 'ru' | 'en';
}

/** Ответ: ключ задачи; `commented` — задача уже была открыта, находка ушла комментарием. */
export interface FileSplitTicketResult {
  key: string;
  created: boolean;
  commented?: true;
}

/** Запрос «Завести тикет» — отдельно от хука, чтобы проверять его без React. */
export const fileSplitTicketMutation = {
  mutationFn: async (input: FileSplitTicketInput) => {
    const { data } = await apiClient.post<FileSplitTicketResult>(
      `/chat/split/${encodeURIComponent(input.parentChatId)}/tickets/file`,
      { key: input.key, description: input.description, lang: input.lang },
    );
    return data;
  },
};

/**
 * «Завести» предложенный группой тикет в трекере проекта (L277) — после
 * подтверждения человека в строке хаба. Повтор безопасен: сервер отдаёт уже
 * заведённый ключ, вторую задачу не заводит.
 */
export function useFileSplitTicket() {
  // Отказ показывает строка хаба своим тостом — общий молчит.
  return useMutation({ ...fileSplitTicketMutation, meta: { silentError: true } });
}
