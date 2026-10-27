import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  SplitTicketDuplicates,
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

/**
 * Не под корнем `chat-tree`: его сбрасывают публикация, кнопки групп и событие
 * сторожа — и открытое окно каждый раз заново читало бы Jira («куда» и поиск
 * повторов), хотя ни то ни другое от дерева не зависит.
 */
export const splitTicketBatchKeys = {
  target: (parentChatId: string, project: string, last: string) =>
    ['split-tickets', 'target', parentChatId, project, last] as const,
  duplicates: (parentChatId: string, project: string) =>
    ['split-tickets', 'duplicates', parentChatId, project] as const,
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

export interface SplitTicketDuplicatesInput {
  parentChatId: string;
  /** Проект Jira, куда уйдёт публикация: повторы ищутся в нём. */
  project: string;
}

/**
 * Проверка на повторы до публикации (владелец 25.10.2026): открытые задачи
 * Jira, похожие на дефекты окна. Только чтение; решает человек в окне.
 */
export function useSplitTicketDuplicates(input: SplitTicketDuplicatesInput, enabled: boolean) {
  return useQuery({
    queryKey: splitTicketBatchKeys.duplicates(input.parentChatId, input.project),
    queryFn: async () => {
      const { data } = await apiClient.get<SplitTicketDuplicates>(
        `${base(input.parentChatId)}/tickets/duplicates`,
        { params: { project: input.project } },
      );
      return data;
    },
    enabled: enabled && Boolean(input.project),
    // Задачи в Jira заводят и закрывают мимо окна: открытое заново ищет свежее.
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
