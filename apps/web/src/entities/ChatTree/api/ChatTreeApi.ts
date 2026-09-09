import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  ChatTreePaused,
  ChatTreeResumed,
  ChatTreeView,
  SplitOverlapView,
  SplitReviewOutcome,
} from '@agentdeck/contracts/chat-handoff';
import type {
  TaskSplitResult,
  TaskSplitReviewDecision,
} from '@agentdeck/contracts/task-split';
import { apiClient } from '@shared/api/client';

/**
 * Дерево разговоров одной просьбы и его пауза — сторона клиента.
 *
 * Дерево считает СЕРВЕР: связи «родитель → потомок» живут у него, и он же
 * глушит автостарты в стоящем дереве, когда вкладки нет. Клиенту остаётся
 * спросить и нажать; корень сервер находит по любому разговору дерева сам.
 */

export const chatTreeKeys = {
  tree: (chatId: string) => ['chat-tree', chatId] as const,
};

/** Сколько ждать между опросами дерева: прогоны в нём стартуют и гаснут без вкладки. */
const TREE_REFETCH_MS = 5000;

export function useChatTree(chatId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: chatTreeKeys.tree(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatTreeView>(
        `/chat/${encodeURIComponent(chatId ?? '')}/tree`,
      );
      return data;
    },
    enabled: Boolean(chatId) && enabled,
    refetchInterval: TREE_REFETCH_MS,
  });
}

export function usePauseTree() {
  return useMutation({
    mutationFn: async (chatId: string) => {
      const { data } = await apiClient.post<ChatTreePaused>(
        `/chat/${encodeURIComponent(chatId)}/tree/pause`,
      );
      return data;
    },
  });
}

export function useResumeTree() {
  return useMutation({
    mutationFn: async (chatId: string) => {
      const { data } = await apiClient.post<ChatTreeResumed>(
        `/chat/${encodeURIComponent(chatId)}/tree/resume`,
      );
      return data;
    },
  });
}

/**
 * Ответ человека на вопрос разбора (Т1). Адресуется РОДИТЕЛЮ, а не чату
 * группы: у стоящей группы чата ещё нет — копия заводится после ответа, и
 * ответ уезжает в её план и в работу заметкой.
 */
export function useAnswerHold() {
  return useMutation({
    mutationFn: async (input: { parentChatId: string; index: number; answer: string }) => {
      const { data } = await apiClient.post<TaskSplitResult>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/hold`,
        { index: input.index, answer: input.answer },
      );
      return data;
    },
  });
}

/**
 * Пересечения веток разделения (Т6) по кнопке в хабе.
 *
 * Это ЧТЕНИЕ, а не действие, и всё же мутация: считает его сервер запросами к
 * git, длится это секунды, и нажатие должно крутить кнопку, а не молча висеть в
 * кэше. Результат приезжает и сам — вместе с деревом, которое пульт и так
 * опрашивает: ответ здесь нужен только чтобы понять, чем кончилось нажатие.
 */
export function useCheckOverlap() {
  return useMutation({
    mutationFn: async (parentChatId: string) => {
      const { data } = await apiClient.get<SplitOverlapView>(
        `/chat/split/${encodeURIComponent(parentChatId)}/overlap`,
      );
      return data;
    },
  });
}

/**
 * Решение человека по ревью чужого MR (Т7). Адресуется РОДИТЕЛЮ с ключом
 * группы: «применить ко всем» — это про соседние группы того же дерева, и знает
 * их сервер.
 *
 * Ответ подробный (что записано в MR, что заведено), потому что решение
 * «и отписать, и починить» может сработать наполовину: комментарий отклонён
 * форджем, а правки пошли. Показать это обязана одна реплика.
 */
export function useReviewDecision() {
  return useMutation({
    mutationFn: async (input: {
      parentChatId: string;
      chatId: string;
      decision: TaskSplitReviewDecision;
      all?: boolean;
    }) => {
      const { data } = await apiClient.post<SplitReviewOutcome>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/review-decision`,
        { chatId: input.chatId, decision: input.decision, ...(input.all ? { all: true } : {}) },
      );
      return data;
    },
  });
}

/**
 * «Закоммитить и отправить в MR» (Т7) — вторым кликом после правок.
 *
 * Отдельной ручкой, а не решением: это запись в ЧУЖУЮ ветку. Панель её не
 * делает сама ни при каких настройках, и согласие человека на неё отдельное.
 */
export function useReviewPush() {
  return useMutation({
    mutationFn: async (input: { parentChatId: string; chatId: string }) => {
      const { data } = await apiClient.post<SplitReviewOutcome>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/review-push`,
        { chatId: input.chatId },
      );
      return data;
    },
  });
}
