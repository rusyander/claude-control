import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  SplitTicketPublishBody,
  SplitTicketPublished,
  SplitTicketTaken,
  SplitTicketTarget,
} from '@agentdeck/contracts/split-ticket-batch';
import { apiClient } from '@shared/api/client';

/**
 * «Разобрать…» в хабе (владелец 24.10.2026): предложенные группами тикеты
 * разом. Чтение «куда заводить» — пока окно открыто; публикация и «Решить
 * здесь» — только по клику человека, отказ показывает окно, общий тост молчит.
 */

const base = (parentChatId: string): string => `/chat/split/${encodeURIComponent(parentChatId)}`;

export const splitTicketBatchKeys = {
  target: (parentChatId: string, project: string, last: string) =>
    ['chat-tree', 'split-tickets-target', parentChatId, project, last] as const,
};

export interface SplitTicketTargetInput {
  parentChatId: string;
  /** Проект, выбранный в окне; пусто — сервер берёт привязку, последний или первый. */
  project: string;
  /** Последний выбранный человеком проект (localStorage панели). */
  last: string;
}

/** Сайт подключённой Jira, её проекты и типы задач выбранного проекта. */
export function useSplitTicketTarget(input: SplitTicketTargetInput, enabled: boolean) {
  return useQuery({
    queryKey: splitTicketBatchKeys.target(input.parentChatId, input.project, input.last),
    queryFn: async () => {
      const { data } = await apiClient.get<SplitTicketTarget>(
        `${base(input.parentChatId)}/tickets/target`,
        {
          params: {
            ...(input.project ? { project: input.project } : {}),
            ...(input.last ? { last: input.last } : {}),
          },
        },
      );
      return data;
    },
    enabled,
    // Интеграцию подключают и отключают мимо окна: открытое заново читает свежее.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export type PublishSplitTicketsInput = SplitTicketPublishBody & { parentChatId: string };

/** Запрос «Опубликовать в Jira» — отдельно от хука, чтобы проверять его без React. */
export const publishSplitTicketsMutation = {
  mutationFn: async ({ parentChatId, ...body }: PublishSplitTicketsInput) => {
    const { data } = await apiClient.post<SplitTicketPublished>(
      `${base(parentChatId)}/tickets/publish`,
      body,
    );
    return data;
  },
};

export function usePublishSplitTickets() {
  return useMutation({ ...publishSplitTicketsMutation, meta: { silentError: true } });
}

export interface TakeSplitTicketsInput {
  parentChatId: string;
  lang: 'ru' | 'en';
}

/** Запрос «Решить здесь»: новый чат с открытыми находками. */
export const takeSplitTicketsMutation = {
  mutationFn: async ({ parentChatId, lang }: TakeSplitTicketsInput) => {
    const { data } = await apiClient.post<SplitTicketTaken>(`${base(parentChatId)}/tickets/take`, {
      lang,
    });
    return data;
  },
};

export function useTakeSplitTickets() {
  return useMutation({ ...takeSplitTicketsMutation, meta: { silentError: true } });
}
