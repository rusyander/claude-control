import { apiClient } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

/** Тело «Завести тикет»: ключ предложения и описание на языке интерфейса. */
export interface FileSplitTicketInput {
  parentChatId: string;
  key: string;
  description: string;
}

/** Запрос «Завести тикет» — отдельно от хука, чтобы проверять его без React. */
export const fileSplitTicketMutation = {
  mutationFn: async (input: FileSplitTicketInput) => {
    const { data } = await apiClient.post<{ key: string; created: boolean }>(
      `/chat/split/${encodeURIComponent(input.parentChatId)}/tickets/file`,
      { key: input.key, description: input.description },
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
